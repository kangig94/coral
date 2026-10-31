import { formatError } from '../../../infra/error-format.js';
import type { TimePort, TimerHandle } from '../../../infra/port-types.js';
import type { ProviderOperationRecord } from '../../../store/provider-operation-record.js';
import type {
  SupersededProviderOperationRetirement,
  UnreadableProviderOperationStartupResolution,
} from './provider-operation-startup-ownership.js';

/** A hold names every obligation still open, so no caller can read one as completion. */
export type SupersededProviderOperationMaintenancePass =
  | Readonly<{ kind: 'settled' }>
  | Readonly<{
      kind: 'holding';
      retainedRows: number;
      unreleasedRows: readonly string[];
      unadoptedRecords: readonly string[];
      pendingJobIds: readonly string[];
    }>;

/** A job's coordinator-job recovery status: a continuation is a durable owner; `active` waits for a retry. */
export type CoordinatorJobRecoveryStatus = 'none' | 'active' | 'retrying' | 'continuation';

export type SupersededProviderOperationMaintenanceDeps = Readonly<{
  time: Pick<TimePort, 'setTimeout' | 'clearTimeout'>;
  retire(): SupersededProviderOperationRetirement;
  releaseOwnership(recordKey: string): UnreadableProviderOperationStartupResolution;
  resolveRetiredStatus(recordKey: string, signal: AbortSignal): Promise<boolean>;
  adoptReadable(record: ProviderOperationRecord, recordKey: string): Promise<'accepted' | 'refused'>;
  /** `undecided`: a row that may name the job cannot be attributed, so recovering it could race that row's owner. */
  ownership(jobId: string): 'settled' | 'owned' | 'undecided' | 'unowned';
  recoveryStatus(jobId: string): CoordinatorJobRecoveryStatus;
  recoverJob(jobId: string, signal: AbortSignal): Promise<unknown>;
  retryRecovery(jobId: string, signal: AbortSignal): Promise<'advanced' | 'held'>;
  completeRecovery(jobId: string): void;
  onObligationChange(): void;
  log(message: string): void;
}>;

const FIRST_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

/**
 * A row a previous generation wrote may fence its job, and every succession, only while a process it names is not
 * proven absent. The row is the job's only durable attribution, so from the moment it is retired until its job is
 * settled or owned elsewhere, this obligation is the job's owner and may not drop it.
 */
export function createSupersededProviderOperationMaintenance(deps: SupersededProviderOperationMaintenanceDeps) {
  const unreleasedRows = new Set<string>();
  const unresolvedStatuses = new Set<string>();
  const unadoptedRecords = new Map<string, ProviderOperationRecord>();
  const pendingJobIds = new Set<string>();
  const abort = new AbortController();
  let timer: TimerHandle | null = null;
  let running: Promise<SupersededProviderOperationMaintenancePass> | null = null;
  let delayMs = FIRST_RETRY_MS;
  let scheduling = false;

  const attempt = async (subject: string, step: () => unknown): Promise<void> => {
    if (abort.signal.aborted) return;
    try {
      await step();
    } catch (error: unknown) {
      if (!abort.signal.aborted) {
        deps.log(`Superseded provider operation ${subject} failed; retrying: ${formatError(error)}`);
      }
    }
  };

  const releaseRetiredRows = async (): Promise<void> => {
    for (const key of [...unreleasedRows]) {
      await attempt(`ownership release for ${key}`, () => {
        const resolution = deps.releaseOwnership(key);
        for (const jobId of resolution.releasedJobIds) pendingJobIds.add(jobId);
        for (const readable of resolution.readableRecords) unadoptedRecords.set(readable.recordKey, readable.record);
        unreleasedRows.delete(key);
      });
    }
    for (const key of [...unresolvedStatuses]) {
      await attempt(`status resolution for ${key}`, async () => {
        if (await deps.resolveRetiredStatus(key, abort.signal)) unresolvedStatuses.delete(key);
      });
    }
    for (const [recordKey, record] of [...unadoptedRecords]) {
      await attempt(`adoption of ${recordKey}`, async () => {
        if ((await deps.adoptReadable(record, recordKey)) === 'accepted') unadoptedRecords.delete(recordKey);
      });
    }
  };

  const settledByRecovery = (jobId: string): boolean => {
    const status = deps.recoveryStatus(jobId);
    return status === 'none' || status === 'continuation';
  };

  const settleJob = async (jobId: string): Promise<boolean> => {
    const ownership = deps.ownership(jobId);
    if (ownership === 'undecided') return false;
    if (ownership !== 'unowned') return true;
    switch (deps.recoveryStatus(jobId)) {
      case 'continuation':
        return true;
      case 'active':
      case 'retrying':
        return (await deps.retryRecovery(jobId, abort.signal)) === 'advanced';
      case 'none':
        await deps.recoverJob(jobId, abort.signal);
        deps.completeRecovery(jobId);
        return settledByRecovery(jobId);
    }
  };

  const recoverPendingJobs = async (): Promise<void> => {
    for (const jobId of [...pendingJobIds]) {
      await attempt(`recovery of job ${jobId}`, async () => {
        if (await settleJob(jobId)) pendingJobIds.delete(jobId);
      });
    }
  };

  const runPass = async (): Promise<SupersededProviderOperationMaintenancePass> => {
    const retirement = deps.retire();
    for (const key of retirement.retiredKeys) {
      unreleasedRows.add(key);
      unresolvedStatuses.add(key);
    }
    if (retirement.retiredKeys.length > 0) deps.onObligationChange();
    await releaseRetiredRows();
    await recoverPendingJobs();
    const open =
      retirement.retained + unreleasedRows.size + unresolvedStatuses.size + unadoptedRecords.size + pendingJobIds.size;
    return open === 0
      ? { kind: 'settled' }
      : {
          kind: 'holding',
          retainedRows: retirement.retained,
          unreleasedRows: [...new Set([...unreleasedRows, ...unresolvedStatuses])],
          unadoptedRecords: [...unadoptedRecords.keys()],
          pendingJobIds: [...pendingJobIds],
        };
  };

  const pass = (): Promise<SupersededProviderOperationMaintenancePass> => {
    running ??= runPass().finally(() => {
      running = null;
    });
    return running;
  };

  const tick = (): void => {
    void pass().then(
      (outcome) => {
        if (outcome.kind === 'settled') return;
        schedule();
        delayMs = Math.min(delayMs * 2, MAX_RETRY_MS);
      },
      (error: unknown) => {
        deps.log(`Superseded provider operation maintenance failed; retrying: ${formatError(error)}`);
        schedule();
      },
    );
  };

  const schedule = (): void => {
    if (!scheduling || abort.signal.aborted || timer !== null) return;
    timer = deps.time.setTimeout(() => {
      timer = null;
      tick();
    }, delayMs);
  };

  const quiesce = async (): Promise<void> => {
    scheduling = false;
    deps.time.clearTimeout(timer);
    timer = null;
    await running?.catch(() => undefined);
  };

  return {
    pass,
    trackStartupRetirement(retirement: SupersededProviderOperationRetirement): void {
      for (const key of retirement.retiredKeys) unresolvedStatuses.add(key);
    },
    start(): void {
      scheduling = true;
      delayMs = FIRST_RETRY_MS;
      tick();
    },
    quiesce,
    async stop(): Promise<void> {
      abort.abort();
      await quiesce();
    },
  };
}
