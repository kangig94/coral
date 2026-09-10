import type { AbortReason } from '../../jobs/outcome.js';
import type { JobAbortRegistryPort, AbortResult } from '../../jobs/contracts/abort-registry.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import type { LaunchCoordinatorPort } from '../../jobs/contracts/admission.js';
import type { QueuedJobAbortPort } from '../../jobs/contracts/job-runner.js';

export interface JobAbortServiceDeps {
  abortRegistry: JobAbortRegistryPort;
  progressStore: JobProgressStore;
  launchAdmission: Pick<LaunchCoordinatorPort, 'cancelQueued' | 'reservationFor'>;
  launchOrchestrator: QueuedJobAbortPort;
}

export class JobAbortService {
  private readonly deps: JobAbortServiceDeps;
  constructor(deps: JobAbortServiceDeps) {
    this.deps = deps;
  }

  abort(jobIds: string[]): AbortResult {
    const aborted: string[] = [];
    const notFound: string[] = [];
    const refused: NonNullable<AbortResult['refused']> = [];
    const held: NonNullable<AbortResult['held']> = [];
    const abandoned: NonNullable<AbortResult['abandoned']> = [];

    for (const jobId of jobIds) {
      if (!this.deps.abortRegistry.has(jobId)) {
        notFound.push(jobId);
        continue;
      }

      const status = this.deps.progressStore.readStatus(jobId);
      const reservation = this.deps.launchAdmission.reservationFor(jobId);
      if (
        status?.phase === 'queued' &&
        status.sessionId !== null &&
        reservation?.kind === 'queued' &&
        this.deps.launchAdmission.cancelQueued(reservation.reservationId, reservation.pool)
      ) {
        this.finishQueuedAbort(jobId, status.sessionId, 'queue_shutdown');
        aborted.push(jobId);
        continue;
      }

      const result = this.deps.abortRegistry.abort([jobId]);
      aborted.push(...result.aborted);
      notFound.push(...result.notFound);
      refused.push(...(result.refused ?? []));
      held.push(...(result.held ?? []));
      abandoned.push(...(result.abandoned ?? []));
    }

    return {
      aborted,
      notFound,
      ...(refused.length === 0 ? {} : { refused }),
      ...(held.length === 0 ? {} : { held }),
      ...(abandoned.length === 0 ? {} : { abandoned }),
    };
  }

  finishQueuedAbort(jobId: string, sessionId: string, reason: AbortReason): void {
    this.deps.launchOrchestrator.finishQueuedAbort(jobId, sessionId, reason);
  }
}
