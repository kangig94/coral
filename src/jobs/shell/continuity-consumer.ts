import type { ProviderEventBody, ProviderTerminalEventBody } from '../../providers/contract.js';
import type { ProviderBindingResult } from '../../providers/contracts/binding.js';
import type { ProviderValidatedContinuityBlob } from '../../sessions/continuity.js';
import type { SessionJobClaimPort } from '../../sessions/contracts.js';
import { backendLog } from '../../infra/backend-log.js';
import { isRecord } from '../../infra/json.js';
import { commitContinuityEvent, rejectContinuityEvent } from '../../providers/internal/continuity-commit.js';

export async function consumeJobStream(options: {
  jobId: string;
  sessionId: string;
  initialVersion: number;
  stream: AsyncIterable<ProviderEventBody>;
  decodeContinuity(rawContinuity: unknown): ProviderBindingResult<ProviderValidatedContinuityBlob | undefined>;
  sessionApi: Pick<SessionJobClaimPort, 'checkpointJobContinuityAtomic' | 'recordArtifactHandleAtomic'>;
  appendProgress(message: string): void;
}): Promise<
  | { kind: 'terminal'; event: ProviderTerminalEventBody; claimVersion: number }
  | { kind: 'suspended'; reason: 'interrupt_unconfirmed' | 'durable_state_uncommitted' }
> {
  const { sessionId, stream, sessionApi } = options;
  let expectedVersion = options.initialVersion;

  for await (const event of stream) {
    if (event.kind === 'progress') {
      options.appendProgress(event.message);
      continue;
    }

    if (event.kind === 'continuity') {
      const continuity = options.decodeContinuity(event.providerContinuity);
      if (!continuity.ok) {
        const error = new Error(`Provider emitted invalid continuity for claimed job ${options.jobId}.`);
        rejectContinuityEvent(event, error);
        backendLog.warn(
          `Provider continuity validation failed for claimed job ${options.jobId} on session ${sessionId}; preserving durable ownership.`,
        );
        return { kind: 'suspended', reason: 'durable_state_uncommitted' };
      }
      let result: Awaited<ReturnType<SessionJobClaimPort['checkpointJobContinuityAtomic']>>;
      try {
        result = await sessionApi.checkpointJobContinuityAtomic(sessionId, {
          expectedActiveJobId: options.jobId,
          expectedVersion,
          snapshot: {
            conversationRef: event.conversationRef,
            resumable: event.resumable,
            providerContinuity: isRecord(continuity.value) ? continuity.value : null,
          },
        });
      } catch (error) {
        rejectContinuityEvent(event, error);
        backendLog.warn(
          `Continuity checkpoint failed for claimed job ${options.jobId} on session ${sessionId}; preserving durable ownership.`,
        );
        return { kind: 'suspended', reason: 'durable_state_uncommitted' };
      }
      if (!result.ok) {
        const error = new Error(
          `Continuity checkpoint lost the active claim for job ${options.jobId} on session ${sessionId}.`,
        );
        rejectContinuityEvent(event, error);
        backendLog.warn(`Continuity checkpoint went stale for claimed job ${options.jobId} on session ${sessionId}.`);
        return { kind: 'suspended', reason: 'durable_state_uncommitted' };
      }

      expectedVersion = result.nextVersion;
      commitContinuityEvent(event);
      continue;
    }

    if (event.kind === 'artifact_handle') {
      let result: Awaited<ReturnType<SessionJobClaimPort['recordArtifactHandleAtomic']>>;
      try {
        result = await sessionApi.recordArtifactHandleAtomic(sessionId, {
          expectedActiveJobId: options.jobId,
          expectedVersion,
          handle: event.handle,
          identity: event.identity,
          sourceJobId: options.jobId,
        });
      } catch {
        backendLog.warn(
          `Artifact handle recording failed for claimed job ${options.jobId} on session ${sessionId}; preserving durable ownership.`,
        );
        return { kind: 'suspended', reason: 'durable_state_uncommitted' };
      }
      if (!result.ok) {
        backendLog.warn(
          `Artifact handle recording went stale for claimed job ${options.jobId} on session ${sessionId}.`,
        );
        return { kind: 'suspended', reason: 'durable_state_uncommitted' };
      }

      expectedVersion = result.nextVersion;
      continue;
    }

    if (event.kind === 'suspended') return event;

    return { kind: 'terminal', event, claimVersion: expectedVersion };
  }

  throw new Error(`Provider stream for ${options.jobId} completed without a terminal event.`);
}
