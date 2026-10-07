import assert from 'node:assert/strict';
import type { JobDetailResponse } from '#src/jobs/records.js';
import type { WaitCursor } from '#src/jobs/wait/contract.js';
import { encodeWaitCursor, waitEpochTag } from '#src/jobs/wait/cursor.js';
import { WaitSession, type WaitAdmission } from '#src/jobs/wait/session.js';

/** The active epoch every fixture admission below is read from. */
export const TEST_EPOCH = 'epoch-E';

export function admitted(
  jobId: string,
  messages: Array<[number, string]> = [],
  terminal = true,
  epochKey = TEST_EPOCH,
  failed = false,
  terminalSeq = 1000,
): WaitAdmission & { detail: JobDetailResponse } {
  const result = {
    content: `${jobId} result`,
    outcome: failed ? { kind: 'provider_exit', code: 42 } : { kind: 'completed' },
    durationMs: 7,
  } as const;
  return {
    jobId,
    disposition: 'admitted',
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
        lastSeq: terminalSeq,
      },
      terminalSeq: terminal ? terminalSeq : undefined,
      exit: terminal ? { ...result, diagnostics: { progressFaults: [] } } : null,
      events: [
        ...messages.map(([seq, message]) => ({
          type: 'progress',
          jobId,
          seq,
          message,
          timing: { origin: 'runtime', originAt: '', emittedAt: '', elapsedMs: 0 },
        })),
        ...(terminal ? [{ type: 'terminal', jobId, seq: terminalSeq, result }] : []),
      ],
      readiness: 'ready',
    } as never,
  };
}

/** A saved cursor whose watermark is `seq` in the given epoch. */
export function savedCursor(seq: number, epochKey = TEST_EPOCH): WaitCursor {
  const cursor = encodeWaitCursor({ epochTag: waitEpochTag(epochKey), seq });
  assert(cursor !== null);
  return cursor;
}

/** A client session whose active epoch is the fixtures' epoch. */
export function testSession(jobIds: readonly string[], cursor?: WaitCursor): WaitSession {
  return new WaitSession(jobIds, cursor, TEST_EPOCH);
}
