import type { ProviderEventBody, ProviderTerminalEventBody } from '../../providers/contract.js';
import type { ProviderBindingResult } from '../../providers/contracts/binding.js';
import type { ProviderValidatedContinuityBlob } from '../conversation/continuity.js';
import type { ConversationContinuityPort } from '../conversation/contracts.js';
import { backendLog } from '../../infra/backend-log.js';
import { isRecord } from '../../infra/json.js';
import { commitContinuityEvent, rejectContinuityEvent } from '../../providers/internal/continuity-commit.js';

export async function consumeJobStream(options: {
  jobId: string;
  execution: number;
  stream: AsyncIterable<ProviderEventBody>;
  decodeContinuity(rawContinuity: unknown): ProviderBindingResult<ProviderValidatedContinuityBlob | undefined>;
  conversationApi: Pick<ConversationContinuityPort, 'checkpointJobContinuityAtomic' | 'recordArtifactHandleAtomic'>;
  appendProgress(message: string): void;
}): Promise<
  | { kind: 'terminal'; event: ProviderTerminalEventBody; execution: number }
  | { kind: 'suspended'; reason: 'interrupt_unconfirmed' | 'durable_state_uncommitted' }
> {
  const { jobId, stream, conversationApi } = options;
  const execution = options.execution;

  for await (const event of stream) {
    if (event.kind === 'progress') {
      options.appendProgress(event.message);
      continue;
    }

    if (event.kind === 'continuity') {
      const continuity = options.decodeContinuity(event.providerContinuity);
      if (!continuity.ok) {
        const error = new Error(`Provider emitted invalid continuity for job ${options.jobId}.`);
        rejectContinuityEvent(event, error);
        backendLog.warn(
          `Provider continuity validation failed for job ${options.jobId} execution #${execution}; preserving durable ownership.`,
        );
        return { kind: 'suspended', reason: 'durable_state_uncommitted' };
      }
      let result: Awaited<ReturnType<ConversationContinuityPort['checkpointJobContinuityAtomic']>>;
      try {
        result = await conversationApi.checkpointJobContinuityAtomic(jobId, {
          execution,
          snapshot: {
            conversationRef: event.conversationRef,
            resumable: event.resumable,
            providerContinuity: isRecord(continuity.value) ? continuity.value : null,
          },
        });
      } catch (error) {
        rejectContinuityEvent(event, error);
        backendLog.warn(
          `Continuity checkpoint failed for job ${options.jobId} execution #${execution}; preserving durable ownership.`,
        );
        return { kind: 'suspended', reason: 'durable_state_uncommitted' };
      }
      if (!result.ok) {
        const error = new Error(
          `Continuity checkpoint lost the open execution for job ${options.jobId} execution #${execution}.`,
        );
        rejectContinuityEvent(event, error);
        backendLog.warn(`Continuity checkpoint went stale for job ${options.jobId} execution #${execution}.`);
        return { kind: 'suspended', reason: 'durable_state_uncommitted' };
      }

      commitContinuityEvent(event);
      continue;
    }

    if (event.kind === 'artifact_handle') {
      let result: Awaited<ReturnType<ConversationContinuityPort['recordArtifactHandleAtomic']>>;
      try {
        result = await conversationApi.recordArtifactHandleAtomic(jobId, {
          execution,
          handle: event.handle,
          identity: event.identity,
        });
      } catch {
        backendLog.warn(
          `Artifact handle recording failed for job ${options.jobId} execution #${execution}; preserving durable ownership.`,
        );
        return { kind: 'suspended', reason: 'durable_state_uncommitted' };
      }
      if (!result.ok) {
        backendLog.warn(`Artifact handle recording went stale for job ${options.jobId} execution #${execution}.`);
        return { kind: 'suspended', reason: 'durable_state_uncommitted' };
      }

      continue;
    }

    if (event.kind === 'suspended') return event;

    return { kind: 'terminal', event, execution };
  }

  throw new Error(`Provider stream for ${options.jobId} completed without a terminal event.`);
}
