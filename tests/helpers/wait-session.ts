import type { WaitAdmission } from '#src/jobs/wait/session.js';

export function admitted(
  jobId: string,
  messages: Array<[number, string]> = [],
  terminal = true,
  epochKey = 'epoch-E',
  failed = false,
): WaitAdmission {
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
