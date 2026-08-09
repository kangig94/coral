import type { JobProgressStore } from './contracts/job-store.js';
import { elapsedDurationMs } from './duration.js';
import { buildJobEventRefs } from './refs.js';
import { appendJobTerminalRecorded, failedTerminalOutcome } from './terminal/recording.js';
import { deleteProviderOperation } from '../store/provider-operation-journal.js';
import type {
  ProviderOperationRecord,
  ProviderOperationTerminalDirective,
} from '../store/provider-operation-record.js';

type ProviderOperationTerminalizationStore = Pick<
  JobProgressStore,
  'getDb' | 'commit' | 'readStatus' | 'readLaunchProjection'
>;

type ProviderOperationTerminalizationResult =
  | Readonly<{ kind: 'terminalized' }>
  | Readonly<{ kind: 'conflict'; current: ProviderOperationRecord | null }>;

export interface ProviderOperationTerminalizationPort {
  terminalize(
    record: ProviderOperationRecord,
    directive: ProviderOperationTerminalDirective,
  ): ProviderOperationTerminalizationResult;
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
    throw new Error(`Provider operation job '${record.operation.jobId}' lacks durable terminal metadata.`);
  }
  const durationMs = elapsedDurationMs(launch.createdAt, nowMs, `job ${record.operation.jobId}`);
  let result: ProviderOperationTerminalizationResult | null = null;

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

  if (result === null) throw new Error('Provider operation terminalization completed without a result.');
  return result;
}
