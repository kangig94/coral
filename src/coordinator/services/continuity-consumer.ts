import type { JobContinuitySnapshot } from '../contracts.js';
import type {
  JobDiagnostics,
  JobTerminal,
  ProviderContinuityBlob,
  ProviderEventBody,
} from '../../providers/contract.js';
import type { ContinuitySnapshot } from '../../sessions/continuity.js';

type SessionContinuityApi = {
  readClaimVersion(sessionId: string, expectedActiveJobId: string): number;
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
  stream: AsyncIterable<ProviderEventBody>;
  sessionApi: SessionContinuityApi;
  appendProgress(message: string): void;
  appendTerminal(terminal: JobTerminal, diagnostics: JobDiagnostics): void;
}): Promise<{
  terminal: JobTerminal;
  diagnostics: JobDiagnostics;
  finalContinuity: JobContinuitySnapshot | null;
}> {
  const { sessionId, stream, sessionApi } = options;
  let finalContinuity: JobContinuitySnapshot | null = null;
  let expectedVersion: number | null = null;

  for await (const event of stream) {
    if (event.kind === 'progress') {
      options.appendProgress(event.message);
      continue;
    }

    if (event.kind === 'continuity') {
      const continuity = toJobContinuitySnapshot(event.providerContinuity, event.conversationRef, event.resumable);
      const result = await sessionApi.checkpointJobContinuityAtomic(sessionId, {
        expectedActiveJobId: options.jobId,
        expectedVersion: expectedVersion ?? sessionApi.readClaimVersion(sessionId, options.jobId),
        snapshot: {
          conversationRef: continuity.conversationRef,
          resumable: continuity.resumable,
          providerContinuity: continuity.providerContinuity ?? null,
        },
      });
      if (!result.ok) {
        throw new Error(`Failed to checkpoint continuity for claimed job ${options.jobId}.`);
      }

      expectedVersion = result.nextVersion;
      finalContinuity = continuity;
      continue;
    }

    options.appendTerminal(event.terminal, event.diagnostics);
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

function isProviderContinuityBlob(value: unknown): value is ProviderContinuityBlob {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
