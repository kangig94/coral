import type { JobDetailResponse } from '#src/jobs/records.js';
import { expect, it } from 'vitest';
import { WaitSession, type WaitAdmission } from '#src/jobs/wait/session.js';
import { selectWaitSnapshot } from '#tests/helpers/wait-progress.js';
import { waitEpochToken, waitJobHash } from '#src/jobs/wait/cursor.js';

const E = JSON.stringify({ storeRoot: '/s', epoch: '1', path: '/s/epoch-1/store.db' });
const timing = { origin: 'runtime' as const, originAt: 't', emittedAt: 't', elapsedMs: 0 };
function admission(jobId: string, seqs: number[]): WaitAdmission & { detail: JobDetailResponse } {
  return {
    jobId,
    disposition: 'admitted',
    sourceRead: 'readable',
    epochKey: E,
    detail: {
      status: { jobId, phase: 'running' } as never,
      events: seqs.map((seq) => ({
        type: 'progress' as const,
        jobId,
        sessionId: null,
        seq,
        ts: 't',
        message: `${jobId}-${seq}`,
        timing,
      })),
      readiness: 'ready',
      exit: null,
    },
  };
}

it('tail-pending member resolving into a prefix sibling epoch', () => {
  // A was collected up to seq 100; A has 100 unread lines (101..200). U was unresolved (0xff + TAIL) and now resolves into E.
  const input = {
    version: 'jobs.wait.v3' as const,

    jobs: [
      { hash: waitJobHash('A'), epoch: waitEpochToken(E), seq: 100, lineOffset: 0, flags: 0 },
      { hash: waitJobHash('U'), epoch: null, seq: 0, lineOffset: 0, flags: 4 },
    ],
  };
  const aSeqs = Array.from({ length: 200 }, (_, i) => i + 1).filter((s) => s % 2 === 1); // A: odd seqs 1..199
  const uSeqs = Array.from({ length: 30 }, (_, i) => 201 + i); // U: 201..230
  const session = new WaitSession(['A', 'U'], input, 'active-epoch');
  session.reconcile([admission('A', aSeqs), admission('U', uSeqs)]);
  const snap = selectWaitSnapshot(session);
  const a = snap.jobs.find((j) => j.jobId === 'A')!;
  const u = snap.jobs.find((j) => j.jobId === 'U')!;

  // A's unread lines after its saved watermark (101..199 odd = 50 lines) must not be skipped.
  expect(a.progress).toEqual(aSeqs.filter((seq) => seq > 100).map((seq) => `A-${seq}`));
  expect(u.progress).toEqual(uSeqs.slice(-20).map((seq) => `U-${seq}`));
  expect(snap.notices.filter((notice) => notice.includes('was not shown'))).toEqual([expect.stringContaining('U')]);
  expect(snap.notices.join(' ')).not.toContain('replay');
});
