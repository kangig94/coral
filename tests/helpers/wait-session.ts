import type { JobDetailResponse } from '#src/jobs/records.js';
import type { WaitCursor } from '#src/jobs/wait/contract.js';
import { waitEpochToken, waitJobHash } from '#src/jobs/wait/cursor.js';
import type { WaitAdmission } from '#src/jobs/wait/session.js';

export function admitted(
  jobId: string,
  messages: Array<[number, string]> = [],
  terminal = true,
  epochKey = 'epoch-E',
  failed = false,
): WaitAdmission & { detail: JobDetailResponse } {
  const result = {
    content: `${jobId} result`,
    outcome: failed ? { kind: 'provider_exit', code: 42 } : { kind: 'completed' },
    durationMs: 7,
  } as const;
  return {
    jobId,
    disposition: 'admitted',
    sourceRead: 'readable',
    epochKey,
    availability: { kind: 'available', resultPath: `/results/${jobId}` },
    detail: {
      status: {
        jobId,
        owner: { kind: 'provider-session', id: 's' },
        sessionId: null,
        provider: null,
        projectRoot: '/tmp',
        workDir: '/tmp',
        backendNamespace: 'test',
        jobKind: 'provider',
        updatedAt: '',
        phase: terminal ? (failed ? 'error' : 'completed') : 'running',
        lastSeq: 1000,
      },
      terminalSeq: terminal ? 1000 : undefined,
      exit: terminal ? { ...result, diagnostics: { progressFaults: [] } } : null,
      events: [
        ...messages.map(([seq, message]) => ({
          type: 'progress',
          jobId,
          seq,
          message,
          timing: { origin: 'runtime', originAt: '', emittedAt: '', elapsedMs: 0 },
        })),
        ...(terminal ? [{ type: 'terminal', jobId, seq: 1000, result }] : []),
      ],
      readiness: 'ready',
    } as never,
  };
}

/** A saved single-shape cursor positioning each named job at its sequence in one epoch. */
export function savedCursor(positions: Record<string, number>, epochKey = 'epoch-E'): WaitCursor {
  return {
    jobs: Object.entries(positions).map(([jobId, seq]) => ({
      hash: waitJobHash(jobId),
      epoch: waitEpochToken(epochKey),
      seq,
      lineOffset: 0,
      flags: 0,
    })),
  };
}
