import type { JobContinuitySnapshot } from '../continuity.js';
import type { ProviderEventBody, ProviderTerminalEventBody } from '../../providers/contract.js';
import type { SessionJobClaimPort } from '../../sessions/contracts.js';
import { backendLog } from '../../infra/backend-log.js';
import { isRecord } from '../../infra/json.js';

export async function consumeJobStream(options: {
  jobId: string;
  providerName: string;
  sessionId: string;
  initialVersion: number;
  stream: AsyncIterable<ProviderEventBody>;
  sessionApi: Pick<SessionJobClaimPort, 'checkpointJobContinuityAtomic' | 'recordArtifactHandleAtomic'>;
  appendProgress(message: string): void;
  recordTerminal(event: ProviderTerminalEventBody): void;
}): Promise<{
  terminal: ProviderTerminalEventBody['terminal'];
  diagnostics: ProviderTerminalEventBody['diagnostics'];
  finalContinuity: JobContinuitySnapshot | null;
}> {
  const { sessionId, stream, sessionApi } = options;
  let finalContinuity: JobContinuitySnapshot | null = null;
  let expectedVersion = options.initialVersion;

  for await (const event of stream) {
    if (event.kind === 'progress') {
      options.appendProgress(event.message);
      continue;
    }

    if (event.kind === 'continuity') {
      const continuity = toJobContinuitySnapshot(event.providerContinuity, event.conversationRef, event.resumable);
      const result = await sessionApi.checkpointJobContinuityAtomic(sessionId, {
        expectedActiveJobId: options.jobId,
        expectedVersion,
        snapshot: {
          conversationRef: continuity.conversationRef,
          resumable: continuity.resumable,
          providerContinuity: continuity.providerContinuity ?? null,
        },
      });
      if (!result.ok) {
        backendLog.warn(
          `Continuity checkpoint went stale for claimed job ${options.jobId} on session ${sessionId}; draining terminal.`,
        );
        continue;
      }

      expectedVersion = result.nextVersion;
      finalContinuity = continuity;
      continue;
    }

    if (event.kind === 'artifact_handle') {
      const result = await sessionApi.recordArtifactHandleAtomic(sessionId, {
        expectedActiveJobId: options.jobId,
        expectedVersion,
        provider: options.providerName,
        handle: event.handle,
        identity: event.identity,
        sourceJobId: options.jobId,
      });
      if (!result.ok) {
        backendLog.warn(
          `Artifact handle recording went stale for claimed job ${options.jobId} on session ${sessionId}; draining terminal.`,
        );
        continue;
      }

      expectedVersion = result.nextVersion;
      continue;
    }

    options.recordTerminal(event);
    return {
      terminal: event.terminal,
      diagnostics: event.diagnostics,
      finalContinuity,
    };
  }

  throw new Error(`Provider stream for ${options.jobId} completed without a terminal event.`);
}

function toJobContinuitySnapshot(
  providerContinuity: unknown,
  conversationRef: string | null,
  resumable: boolean,
): JobContinuitySnapshot {
  return {
    conversationRef,
    resumable,
    ...(isRecord(providerContinuity) ? { providerContinuity } : {}),
  };
}
