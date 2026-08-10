import type { JobProgressStore } from './contracts/job-store.js';
import { elapsedDurationMs } from './duration.js';
import { buildJobEventRefs } from './refs.js';
import { appendJobTerminalRecorded, failedTerminalOutcome } from './terminal/recording.js';
import { deleteProviderOperation, ProviderOperationJournalError } from '../store/provider-operation-journal.js';
import type {
  ProviderOperationIdentity,
  ProviderOperationRecord,
  ProviderOperationTerminalDirective,
} from '../store/provider-operation-record.js';

type ProviderOperationTerminalizationStore = Pick<
  JobProgressStore,
  'getDb' | 'commit' | 'readStatus' | 'readLaunchProjection'
>;

export type ProviderOperationTerminalizationResult =
  | Readonly<{ kind: 'terminalized' }>
  | Readonly<{ kind: 'conflict'; current: ProviderOperationRecord | null }>;

export interface ProviderOperationTerminalizationPort {
  terminalize(
    record: ProviderOperationRecord,
    directive: ProviderOperationTerminalDirective,
  ): ProviderOperationTerminalizationResult;
}

export class ProviderOperationTerminalMetadataError extends Error {
  readonly operation: ProviderOperationIdentity;

  constructor(operation: ProviderOperationIdentity) {
    super(`Provider operation job '${operation.jobId}' lacks durable terminal metadata.`);
    this.name = 'ProviderOperationTerminalMetadataError';
    this.operation = operation;
    Object.setPrototypeOf(this, ProviderOperationTerminalMetadataError.prototype);
  }
}

export class ProviderOperationTerminalizationUnavailableError extends Error {
  readonly incident: Readonly<{ kind: 'provider-operation-terminalization-unavailable' }>;

  constructor(options?: ErrorOptions) {
    super('Provider operation terminalization store is temporarily unavailable.', options);
    this.name = 'ProviderOperationTerminalizationUnavailableError';
    this.incident = { kind: 'provider-operation-terminalization-unavailable' };
    Object.setPrototypeOf(this, ProviderOperationTerminalizationUnavailableError.prototype);
  }
}

export class ProviderOperationAtomicTerminalizationError extends Error {
  readonly operation: ProviderOperationIdentity;
  readonly proof = 'atomic-provider-operation-terminalization' as const;

  constructor(operation: ProviderOperationIdentity, cause: unknown) {
    super('Atomic provider operation terminalization failed with retry-safe uncertainty.', { cause });
    this.name = 'ProviderOperationAtomicTerminalizationError';
    this.operation = operation;
    Object.setPrototypeOf(this, ProviderOperationAtomicTerminalizationError.prototype);
  }
}

export function terminalizeProviderOperation(
  store: ProviderOperationTerminalizationStore,
  record: ProviderOperationRecord,
  directive: ProviderOperationTerminalDirective,
  nowMs: number,
): ProviderOperationTerminalizationResult {
  const status = store.readStatus(record.operation.jobId);
  const launch = store.readLaunchProjection(record.operation.jobId);
  if (status === null || status.sessionId === null || launch === null) {
    throw new ProviderOperationTerminalMetadataError(record.operation);
  }
  const durationMs = elapsedDurationMs(launch.createdAt, nowMs, `job ${record.operation.jobId}`);
  let result: ProviderOperationTerminalizationResult | null = null;

  try {
    store.commit((commit) => {
      const deleted = deleteProviderOperation(store.getDb(), record);
      if (deleted.kind === 'conflict') {
        result = { kind: 'conflict', current: deleted.current };
        return undefined;
      }

      const options = {
        jobId: record.operation.jobId,
        sessionId: status.sessionId,
        namespace: status.backendNamespace,
        project: status.projectRoot,
      } as const;
      if (directive.kind === 'terminal-aborted') {
        appendJobTerminalRecorded(commit, {
          ...options,
          terminal: {
            content: '',
            durationMs,
            outcome: { kind: 'aborted', reason: directive.cause },
          },
        });
      } else {
        const cause = commit.append({
          type: 'job.progress.emitted',
          stream: { kind: 'job', id: record.operation.jobId },
          namespace: status.backendNamespace,
          project: status.projectRoot,
          refs: buildJobEventRefs({ jobId: record.operation.jobId, sessionId: status.sessionId }),
          body: {
            kind: 'domain',
            stage: 'provider_operation_failed',
            message: directive.reason,
            detail: { code: directive.code },
          },
        });
        appendJobTerminalRecorded(commit, {
          ...options,
          terminal: { content: '', durationMs, outcome: failedTerminalOutcome(cause) },
        });
      }
      result = { kind: 'terminalized' };
      return undefined;
    });
  } catch (error: unknown) {
    if (
      error instanceof ProviderOperationJournalError ||
      error instanceof ProviderOperationTerminalizationUnavailableError
    ) {
      throw error;
    }
    throw new ProviderOperationAtomicTerminalizationError(record.operation, error);
  }

  if (result === null) throw new Error('Provider operation terminalization completed without a result.');
  return result;
}
