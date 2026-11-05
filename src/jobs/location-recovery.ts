import { sha256Hex } from '../infra/hash.js';
import { PROJECTION_JOB_COLUMNS, type ProjectionJobStoredRow } from './projection-row.js';
import type { RecoveryObservation } from '../recovery/phase-observation.js';
import { type Database, withImmediate } from '../store/db.js';
import type { JobProgressStore } from './contracts/job-store.js';
import { type JobLocationIndex } from './location-index.js';
import type { RecoverySubject } from '../recovery/containment.js';
import type { RecoverySourceFactoryPlan } from '../recovery/source-registry.js';
import { loadRetainedCurrentJob } from './retained-current.js';
import { jobLocationRecoverySource } from './location-recovery-source.js';
import { observeDatabaseReads } from '../recovery/read-observation.js';

type RecoveryJobEvidence = { stream_id: string; seq: number; count: number; dependency: string };

type JournalEvidence = { seq: number; count: number };
type StreamEvidence = { stream_id: string; seq: number; count: number; opened: number };

function validatedRecoveryEvidence(
  db: Database,
  journal: JournalEvidence,
  evidence: ReturnType<JobLocationIndex['recoveryEvidence']>,
): ReturnType<JobLocationIndex['recoveryEvidence']> {
  if (evidence === null || evidence.journal.seq > journal.seq) return null;
  const streams = new Map(evidence.streams.map((stream) => [stream.stream_id, stream]));
  const jobs = new Map(evidence.jobs.map((job) => [job.jobId, job]));
  if (streams.size !== evidence.streams.length || jobs.size !== evidence.jobs.length) return null;
  const opened = evidence.streams.filter((stream) => stream.opened > 0);
  if (
    opened.length !== jobs.size ||
    opened.some((stream) => {
      const job = jobs.get(stream.stream_id);
      return job === undefined || job.seq !== stream.seq || job.count !== stream.count;
    })
  )
    return null;
  const checkpoint =
    evidence.journal.seq === journal.seq
      ? journal
      : db
          .prepare<
            [number],
            JournalEvidence
          >('SELECT COALESCE(MAX(seq), 0) AS seq, COUNT(*) AS count FROM events WHERE seq <= ?')
          .get(evidence.journal.seq);
  if (checkpoint?.seq !== evidence.journal.seq || checkpoint.count !== evidence.journal.count) return null;
  const actual = db
    .prepare<[number], StreamEvidence>(
      `SELECT stream_id, MAX(seq) AS seq, COUNT(*) AS count, SUM(type = 'job.opened') AS opened
     FROM events WHERE stream_kind = 'job' AND seq <= ? GROUP BY stream_id`,
    )
    .all(evidence.journal.seq);
  if (
    actual.length !== streams.size ||
    actual.some((stream) => {
      const cached = streams.get(stream.stream_id);
      return (
        cached === undefined ||
        cached.seq !== stream.seq ||
        cached.count !== stream.count ||
        cached.opened !== stream.opened
      );
    })
  )
    return null;
  return evidence;
}

function recoveryJobEvidence(
  db: Database,
  prior: ReturnType<JobLocationIndex['recoveryEvidence']>,
): { jobs: RecoveryJobEvidence[]; streams: StreamEvidence[] } {
  const delta = db
    .prepare<[number], StreamEvidence>(
      `SELECT stream_id, MAX(seq) AS seq, COUNT(*) AS count, SUM(type = 'job.opened') AS opened FROM events
     WHERE stream_kind = 'job' AND seq > ? GROUP BY stream_id
     ORDER BY MIN(seq)`,
    )
    .all(prior?.journal.seq ?? -1);
  const byId = new Map((prior?.streams ?? []).map((row) => [row.stream_id, { ...row }]));
  for (const row of delta) {
    const previous = byId.get(row.stream_id);
    byId.set(row.stream_id, {
      ...row,
      count: row.count + (previous?.count ?? 0),
      opened: row.opened + (previous?.opened ?? 0),
    });
  }
  const jobs = [...byId.values()];
  const workflowEvents = db
    .prepare<
      [],
      { stream_id: string; seq: number; count: number }
    >("SELECT stream_id, MAX(seq) AS seq, COUNT(*) AS count FROM events WHERE stream_kind = 'workflow' GROUP BY stream_id")
    .all();
  const dependencies = new Map<string, unknown[]>(workflowEvents.map((row) => [row.stream_id, [row]]));
  const projections = db
    .prepare<[], ProjectionJobStoredRow>(`SELECT ${PROJECTION_JOB_COLUMNS} FROM projection_jobs ORDER BY job_id`)
    .all();
  const projectionDigests = new Map<string, string>();
  for (const projection of projections) {
    projectionDigests.set(projection.job_id, sha256Hex(JSON.stringify(projection)));
    if (projection.parent_workflow_job_id === null) continue;
    const parent = dependencies.get(projection.parent_workflow_job_id) ?? [];
    parent.push([projection.job_id, byId.get(projection.job_id) ?? null]);
    dependencies.set(projection.parent_workflow_job_id, parent);
  }
  const finishing = new Map<string, unknown[]>();
  const retries = db
    .prepare<
      [],
      { subject_key: string }
    >("SELECT * FROM recovery_quarantine WHERE boundary_id = 'job-execution-finishing' ORDER BY subject_key")
    .all();
  for (const retry of retries) {
    const jobId = retry.subject_key.slice(0, retry.subject_key.lastIndexOf(':'));
    const rows = finishing.get(jobId) ?? [];
    rows.push(retry);
    finishing.set(jobId, rows);
  }
  return {
    streams: jobs,
    jobs: jobs
      .filter((job) => job.opened > 0)
      .map((job) => ({
        ...job,
        dependency: sha256Hex(
          JSON.stringify([
            projectionDigests.get(job.stream_id) ?? null,
            dependencies.get(job.stream_id) ?? [],
            finishing.get(job.stream_id) ?? [],
          ]),
        ),
      })),
  };
}

/** Retirement callers must retain synchronous recovery and certification. */
export function recoverJobLocations(
  index: JobLocationIndex,
  epochKey: string,
  store: JobProgressStore,
  observation?: RecoveryObservation,
): void {
  try {
    const db =
      observation === undefined
        ? store.getDb()
        : observeDatabaseReads(store.getDb(), observation, 'job-location-sources');
    index.withRecoveryGuard(epochKey, () => {
      withImmediate(db, () => {
        const [journal] = db
          .prepare<
            [],
            JournalEvidence
          >('SELECT (SELECT COALESCE(MAX(seq), 0) FROM events) AS seq, (SELECT COUNT(*) FROM events) AS count')
          .all();
        const evidence = validatedRecoveryEvidence(
          db,
          journal,
          index.unknownLocationHold(epochKey) === null ? index.recoveryEvidence(epochKey) : null,
        );
        const { jobs, streams } = recoveryJobEvidence(db, evidence);
        observation?.record('job-opened', { subjects: jobs.length, reads: jobs.length });
        const previous = new Map(evidence?.jobs.map((job) => [job.jobId, job]));
        const unchanged = new Set(
          jobs
            .filter((row) => {
              const prior = previous.get(row.stream_id);
              return (
                prior !== undefined &&
                prior.seq === row.seq &&
                prior.count === row.count &&
                prior.dependency === row.dependency &&
                prior.stamp !== 'unobservable' &&
                prior.stamp === index.recoveryStamp(row.stream_id)
              );
            })
            .map((row) => row.stream_id),
        );
        if (
          evidence !== null &&
          unchanged.size === jobs.length &&
          evidence.jobs.length === jobs.length &&
          evidence.revision === index.revision(epochKey) &&
          evidence.directory !== 'unobservable' &&
          evidence.directory === index.recoveryStamp() &&
          index.unknownLocationHold(epochKey) === null
        )
          return;
        index.reconcileAdmissions(epochKey, db, observation);
        const openedJob = db.prepare<[string], { seq: number }>(
          "SELECT seq FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.opened' LIMIT 1",
        );
        for (const location of index.locationsFor(epochKey, observation)) {
          // Cache inventory is never authority to delete a retained location.
          if (openedJob.get(location.jobId) === undefined)
            index.retireNeverAccepted(location.jobId, epochKey, observation);
        }
        const failures: unknown[] = [];
        for (const row of jobs) {
          if (unchanged.has(row.stream_id)) continue;
          try {
            const location = loadRetainedCurrentJob(db, epochKey, row.stream_id, index.jobsRoot, index.workflowReport);
            if (location === null || location.detail.kind !== 'recorded')
              throw new Error('Job location evidence unavailable');
            index.register(row.stream_id, epochKey, location.subject, undefined, observation);
            index.recordExecutionDetails(row.stream_id, location.executions ?? [], location.detail.value, observation);
          } catch (error: unknown) {
            failures.push(error);
          }
        }
        if (failures.length > 0)
          throw new AggregateError(
            failures,
            failures.map((error) => (error instanceof Error ? error.message : String(error))).join('; '),
          );
        const highWaterSeq =
          db
            .prepare<[], { seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE stream_kind = 'job'")
            .get()?.seq ?? 0;
        observation?.record('job-high-water', { reads: 1 });
        index.clearUnknownLocations(epochKey);
        void index.certify(epochKey, highWaterSeq, observation);
        index.recordRecoveryEvidence(
          epochKey,
          jobs.map((row) => ({
            jobId: row.stream_id,
            seq: row.seq,
            count: row.count,
            dependency: row.dependency,
            stamp: index.recoveryStamp(row.stream_id),
          })),
          journal,
          streams,
        );
      });
    });
  } catch (error: unknown) {
    index.holdUnknownLocations(epochKey, error instanceof Error ? error.message : String(error), true);
    throw error;
  }
}

export function createJobLocationRecoveryRetryPlan(
  index: JobLocationIndex,
  epochKey: string,
  store: JobProgressStore,
  subject: RecoverySubject,
): RecoverySourceFactoryPlan<{ epochKey: string }, { epochKey: string }> {
  return {
    source: jobLocationRecoverySource(epochKey, subject),
    policy: {
      processLocalCleanup: { kind: 'not-required' },
      hydrate: (raw) => raw,
      requiredObligations: () => [],
      settle: () => {
        recoverJobLocations(index, epochKey, store);
        return { kind: 'advanced', outcome: 'settled', facts: [], detail: 'Job location inventory recovered.' };
      },
      onFault: (fault) => {
        index.holdUnknownLocations(
          epochKey,
          `${String(fault.error)}; recovery will re-run at the next coordinator start`,
          false,
        );
        return { kind: 'quarantine', detail: String(fault.error) };
      },
    },
  };
}
