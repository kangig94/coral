import type { JobContinuitySnapshot } from '../continuity.js';
import type {
  ProviderEventBody,
  ProviderTerminalEventBody,
} from '../../providers/contract.js';
import type { ContinuitySnapshot } from '../../sessions/continuity.js';
import { backendLog } from '../../infra/backend-log.js';

type SessionContinuityApi = {
  checkpointJobContinuityAtomic(
    sessionId: string,
    options: {
      expectedActiveJobId: string;
      expectedVersion: number;
      snapshot: ContinuitySnapshot;
    },
  ): Promise<{ ok: true; nextVersion: number } | { ok: false }>;
};

export async function consumeJobStream(options: {
  jobId: string;
  sessionId: string;
  initialVersion: number;
  stream: AsyncIterable<ProviderEventBody>;
  sessionApi: SessionContinuityApi;
  appendProgress(message: string): void;
  appendTerminal(event: ProviderTerminalEventBody): void;
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

    options.appendTerminal(event);
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
    ...(isProviderContinuityBlob(providerContinuity) ? { providerContinuity } : {}),
  };
}

function isProviderContinuityBlob(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
