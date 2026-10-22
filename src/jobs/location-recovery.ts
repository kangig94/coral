import type { RecoveryObservation } from '../recovery/phase-observation.js';
import { withImmediate } from '../store/db.js';
import type { JobProgressStore } from './contracts/job-store.js';
import { type JobLocationIndex } from './location-index.js';
import type { RecoverySubject } from '../recovery/containment.js';
import type { RecoverySourceFactoryPlan } from '../recovery/source-registry.js';
import { loadRetainedCurrentJob } from './retained-current.js';
import { jobLocationRecoverySource } from './location-recovery-source.js';
import { observeDatabaseReads } from '../recovery/read-observation.js';

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
    index.withAdmissionGuard(
      epochKey,
      db,
      () => {
        withImmediate(db, () => {
          const jobs = db
            .prepare<
              [],
              { stream_id: string }
            >("SELECT stream_id FROM events WHERE stream_kind = 'job' AND type = 'job.opened' ORDER BY seq")
            .all();
          observation?.record('job-opened', { subjects: jobs.length, reads: jobs.length });
          const committed = new Set(jobs.map((row) => row.stream_id));
          for (const location of index.locationsFor(epochKey, observation)) {
            if (!committed.has(location.jobId)) index.retireNeverAccepted(location.jobId, epochKey, observation);
          }
          const failures: unknown[] = [];
          for (const row of jobs) {
            try {
              const location = loadRetainedCurrentJob(
                db,
                epochKey,
                row.stream_id,
                index.jobsRoot,
                index.workflowReport,
              );
              if (location === null || location.detail.kind !== 'recorded')
                throw new Error('Job location evidence unavailable');
              index.register(row.stream_id, epochKey, location.subject, undefined, observation);
              index.recordExecutionDetails(
                row.stream_id,
                location.executions ?? [],
                location.detail.value,
                observation,
              );
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
        });
      },
      observation,
    );
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
