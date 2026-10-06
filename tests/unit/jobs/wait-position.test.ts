import type { JobDetailResponse } from '#src/jobs/records.js';
import { expect, it, vi } from 'vitest';
import type { ProgressVisit } from '#src/jobs/wait/contract.js';
import { progressVisitFromEvents } from '#tests/helpers/wait-progress.js';
import { WaitSession, type WaitAdmission } from '#src/jobs/wait/session.js';
import { selectWaitSnapshot } from '#tests/helpers/wait-progress.js';
import { TAIL_SCAN_FLAG, UNPOSITIONED_FLAG, waitEpochToken, waitJobHash } from '#src/jobs/wait/cursor.js';
import { progressPage, progressTail, type RawProgressRow } from '#src/jobs/wait/progress-page.js';

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
    jobs: [
      { hash: waitJobHash('A'), epoch: waitEpochToken(E), seq: 100, lineOffset: 0, flags: 0 },
      { hash: waitJobHash('U'), epoch: null, seq: 0, lineOffset: 0, flags: 4 },
    ],
  };
  const aSeqs = Array.from({ length: 200 }, (_, i) => i + 1).filter((s) => s % 2 === 1); // A: odd seqs 1..199
  const uSeqs = Array.from({ length: 30 }, (_, i) => 201 + i); // U: 201..230
  const session = new WaitSession(['A', 'U'], input);
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

it('fits a byte budget over oversized lines with work linear in the lines it loads', () => {
  const line = 'é'.repeat(26_000);
  const seqs = Array.from({ length: 500 }, (_, index) => index + 1);
  const job = admission('a', seqs);
  for (const event of job.detail.events) if (event.type === 'progress') event.message = line;
  let rows = 0;
  const visit = progressVisitFromEvents(() => job.detail.events);
  const counted: ProgressVisit = (epoch, read) =>
    visit(epoch, (source) =>
      read({
        after: source.after,
        before: (id, before, count) => {
          const page = source.before(id, before, count);
          rows += page.rows.length;
          return page;
        },
      }),
    );
  const session = new WaitSession(['a']);
  session.reconcile([job]);
  const byteLength = vi.spyOn(Buffer, 'byteLength');
  try {
    session.withProgress(counted, (sources) => session.position(sources, 500, 500, 64 * 1024));
    expect(byteLength.mock.calls.length).toBeLessThan(500);
  } finally {
    byteLength.mockRestore();
  }
  expect(rows).toBeLessThanOrEqual(64);
  expect(session.entry('a').seq).toBeGreaterThan(480);
});

it('keeps a cut tail scan unpositioned in its entry and finishes it from that cursor in a later session', () => {
  const raw: RawProgressRow[] = [
    ...Array.from({ length: 30 }, (_, i) => ({
      seq: i + 1,
      progress: { seq: i + 1, message: `line-${i + 1}`, timing },
    })),
    ...Array.from({ length: 2000 }, (_, i) => ({ seq: i + 31 })),
  ];
  let rows = 0;
  const visit: ProgressVisit = (_epoch, read) => ({
    kind: 'read',
    value: read({
      after: (_id, after, count) => {
        const page = raw.filter((row) => row.seq > after).slice(0, count + 1);
        rows += page.length;
        return progressPage(page, count, 2030);
      },
      before: (_id, before, count) => {
        const page = raw
          .filter((row) => before === null || row.seq < before)
          .reverse()
          .slice(0, count + 1);
        rows += page.length;
        return progressTail(page, count, 2030);
      },
    }),
  });
  const job = admission('a', []);
  const first = new WaitSession(['a']);
  first.reconcile([job]);
  first.withProgress(visit, (sources) => first.position(sources, 20, 500, 65536));
  expect(rows).toBeLessThanOrEqual(500);
  const cut = first.cursor().jobs[0];
  expect(cut.flags).toBe(UNPOSITIONED_FLAG | TAIL_SCAN_FLAG);
  expect(cut.lineOffset).toBe(0);
  expect(cut.seq).toBeGreaterThan(30);
  let cursor = first.cursor();
  for (let polls = 0; polls < 5 && (cursor.jobs[0].flags & UNPOSITIONED_FLAG) !== 0; polls++) {
    const later = new WaitSession(['a'], cursor);
    later.reconcile([job]);
    rows = 0;
    later.withProgress(visit, (sources) => later.position(sources, 20, 500, 65536));
    expect(rows).toBeLessThanOrEqual(500);
    cursor = later.cursor();
  }
  expect(cursor.jobs[0]).toMatchObject({ seq: 10, lineOffset: 0, flags: 0 });
});
