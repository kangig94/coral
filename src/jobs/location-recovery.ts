import type { RecoveryObservation } from '../recovery/phase-observation.js';
import { withImmediate, type Database } from '../store/db.js';
import type { JobProgressStore } from './contracts/job-store.js';
import { isTerminalPhase } from './phase.js';
import { deriveLaunchReadiness } from './launch-readiness.js';
import { type JobLocationIndex } from './location-index.js';
import { jobLaunchRequestBodySchema } from './launch.js';
import type { RecoverySubject } from '../recovery/containment.js';
import type { RecoverySourceFactoryPlan } from '../recovery/source-registry.js';
import { jobLocationRecoverySource } from './location-recovery-source.js';

type LaunchIdentityRow = {
  stream_id: string;
  body: Uint8Array;
};

function retireUncommittedLaunches(
  index: JobLocationIndex,
  epochKey: string,
  db: Database,
  observation?: RecoveryObservation,
): void {
  try {
    withImmediate(db, () => {
      const launched = new Set(
        db
          .prepare<[], { stream_id: string }>(
            "SELECT stream_id FROM events WHERE stream_kind = 'job' AND type = 'job.launch.requested'",
          )
          .all()
          .map((row) => {
            observation?.record('uncommitted-launches', { reads: 1 });
            return row.stream_id;
          }),
      );

      const locations = index.locationsFor(epochKey, observation);
      observation?.record('uncommitted-launches', { subjects: locations.length });
      for (const location of locations) {
        if (!launched.has(location.jobId)) index.retireNeverAccepted(location.jobId, epochKey);
      }
    });
  } catch {
    // Failed epoch observation must not retire its jobs.
  }
}

function recoverJobLocation(
  index: JobLocationIndex,
  epochKey: string,
  store: JobProgressStore,
  row: LaunchIdentityRow,
  observation?: RecoveryObservation,
): void {
  const launch = jobLaunchRequestBodySchema.parse(JSON.parse(Buffer.from(row.body).toString('utf8')) as unknown);
  index.register(row.stream_id, epochKey, {
    projectRoot: launch.projectRoot,
    workDir: launch.jobKind === 'kb' ? null : launch.request.cwd,
    jobKind: launch.jobKind,
  });

  const detail = store.loadJobProjectionDetail(row.stream_id, observation);
  const status = detail.status;
  if (status === null) {
    index.markUnresolved(row.stream_id);
    return;
  }
  if (!isTerminalPhase(status.phase)) {
    const events = store.readJobEvents(row.stream_id, false, 0, observation);
    index.recordObserved(row.stream_id, {
      status,
      events,
      readiness: deriveLaunchReadiness(detail),
      exit: detail.exit,
    });
    index.markUnresolved(row.stream_id);
    return;
  }
  const events = store.readJobEvents(row.stream_id, true, 0, observation);
  const terminal = [...events].reverse().find((event) => event.type === 'terminal');
  if (terminal === undefined || detail.exit === null) {
    index.markUnresolved(row.stream_id);
    return;
  }
  const resultPath = index.resultPathFor(row.stream_id);
  index.recordTerminal(
    row.stream_id,
    {
      status,
      events,
      readiness: deriveLaunchReadiness(detail),
      exit: detail.exit,
    },
    resultPath,
    terminal.seq,
  );
  try {
    store.ensureResultArtifact(row.stream_id, observation);
  } catch {
    /* Terminal recording is independent of export success. */
  }
}

/** Retirement callers must retain synchronous recovery and certification. */
export function recoverJobLocations(
  index: JobLocationIndex,
  epochKey: string,
  store: JobProgressStore,
  observation?: RecoveryObservation,
): void {
  try {
    const db = store.getDb();
    if ('configureResultExports' in store && typeof store.configureResultExports === 'function')
      store.configureResultExports(index);
    retireUncommittedLaunches(index, epochKey, db, observation);
    const launches = db
      .prepare<[], LaunchIdentityRow>(
        `SELECT stream_id, body
         FROM events
        WHERE stream_kind = 'job' AND type = 'job.launch.requested'
        ORDER BY seq ASC`,
      )
      .all();
    observation?.record('job-launches', { subjects: launches.length, reads: launches.length });
    const highWaterSeq =
      db.prepare<[], { seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE stream_kind = 'job'").get()
        ?.seq ?? 0;
    observation?.record('job-high-water', { reads: 1 });
    let recoveryError: Error | undefined;
    for (const row of launches) {
      try {
        recoverJobLocation(index, epochKey, store, row, observation);
      } catch (error) {
        recoveryError ??= error instanceof Error ? error : new Error(String(error));
        try {
          index.markUnresolved(row.stream_id);
        } catch {
          // A row whose own location cannot be marked is covered by the epoch hold; it must not stop later rows.
        }
      }
    }
    if (recoveryError !== undefined) throw recoveryError;
    index.clearUnknownLocations(epochKey);
    void index.certify(epochKey, highWaterSeq, observation);
  } catch (error: unknown) {
    index.holdUnknownLocations(epochKey, error instanceof Error ? error.message : String(error), true);
    const locations = index.locationsFor(epochKey, observation);
    for (const location of locations) index.markUnresolved(location.jobId);
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
