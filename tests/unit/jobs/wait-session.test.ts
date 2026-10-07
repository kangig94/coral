import {
  observeWaitRead,
  progressVisitFromDetails,
  selectTestProgress,
  selectWaitSnapshot,
  testProgressVisit,
} from '#tests/helpers/wait-progress.js';
import type { ProgressVisit, WaitProgressRow } from '#src/jobs/wait/contract.js';
import { HistoricalDecodeError } from '#src/jobs/source-read.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { createRealTimePort } from '#src/infra/time.js';
import { admitted, savedCursor, testSession, TEST_EPOCH } from '#tests/helpers/wait-session.js';
import { describe, expect, it } from 'vitest';
import type { WaitSession, WaitAdmission } from '#src/jobs/wait/session.js';

const texts = (rows: ReadonlyArray<{ message: string }>) => rows.map((row) => row.message);

describe('wait session', () => {
  it('cuts in seq order, so the watermark after a budget cut resumes every job exactly where it stopped', () => {
    const session = testSession(['a', 'b']);
    session.reconcile([
      admitted('a', [
        [1, 'a1'],
        [3, 'a3'],
      ]),
      admitted('b', [
        [2, 'b2'],
        [4, 'b4'],
      ]),
    ]);
    expect(texts(selectTestProgress(session, 1))).toEqual(['a1']);
    expect(session.cursor()).toBe(savedCursor(1));
    const resumed = testSession(['b', 'a'], session.cursor()!);
    resumed.reconcile([...session.admissions].reverse());
    expect(texts(selectTestProgress(resumed))).toEqual(['b2', 'a3', 'b4']);
    expect(resumed.notices).toEqual([]);
  });

  it('resumes a job its page cut short from the minimum, repeating later rows of others but losing none', () => {
    const session = testSession(['a', 'b']);
    session.reconcile([
      admitted('a', [
        [1, 'a1'],
        [2, 'a2'],
        [3, 'a3'],
      ]),
      admitted('b', [
        [10, 'b10'],
        [11, 'b11'],
      ]),
    ]);
    expect(texts(selectTestProgress(session, 4))).toEqual(['a1', 'a2', 'b10', 'b11']);
    const resumed = testSession(['a', 'b'], session.cursor()!);
    resumed.reconcile(session.admissions);
    expect(texts(selectTestProgress(resumed))).toEqual(['a3', 'b10', 'b11']);
  });

  it('claims a job the budget cuts mid-page only through its last delivered row, so a resume loses none of it', () => {
    const rows = (tag: string) => Array.from({ length: 20 }, () => tag.repeat(3000)).join('\n');
    const job = admitted(
      'a',
      [
        [1, rows('x')],
        [2, rows('y')],
        [3, 'tail'],
      ],
      false,
    );
    const read = (session: WaitSession) => {
      observeWaitRead(() => session.admissions)();
      return session.withProgress(testProgressVisit, (source) => {
        const selected = session.select(source, { lines: 500, bytes: 65536 }, null);
        session.commit(selected);
        return selected.rows.map((row) => row.message.slice(0, 1));
      });
    };
    const first = testSession(['a'], savedCursor(0));
    first.reconcile([job]);
    expect(read(first)).toEqual(['x']);
    const resumed = testSession(['a'], first.cursor()!);
    resumed.reconcile([job]);
    expect(read(resumed)).toEqual(['y', 't']);
  });

  it('delivers a terminal above the watermark as new and one at or below it as a repeat', () => {
    const a = admitted('a', [[1, 'a1']]);
    const fresh = testSession(['a']);
    fresh.reconcile([a]);
    selectTestProgress(fresh);
    expect(fresh.terminalDelivery(a)).toBe('final');
    const behind = testSession(['a'], savedCursor(999));
    behind.reconcile([a]);
    selectTestProgress(behind);
    expect(behind.terminalDelivery(a)).toBe('final');
    const covered = testSession(['a'], savedCursor(1000));
    covered.reconcile([a]);
    selectTestProgress(covered);
    expect(covered.terminalDelivery(a)).toBe('repeat');
    covered.deliverTerminal(a);
    expect(covered.terminalDelivery(a)).toBeNull();
    expect(covered.remaining()).toEqual([]);
  });

  it('holds the watermark below a terminal this read has not printed, so the next read delivers it as new', () => {
    const a = admitted('a', [[1, 'a1']]);
    const b = admitted('b', [[2, 'b2']], true, TEST_EPOCH, false, 1001);
    const session = testSession(['a', 'b']);
    session.reconcile([a, b]);
    selectTestProgress(session);
    session.deliverTerminal(a);
    expect(session.cursor()).toBe(savedCursor(1000));
    const next = testSession(['b'], session.cursor()!);
    next.reconcile([b]);
    selectTestProgress(next);
    expect(next.terminalDelivery(b)).toBe('final');
  });

  it('uses request-order failure and refusal precedence; excludes missing but retains retryable discovery', () => {
    const a = admitted('a');
    const session = testSession(['a', 'ghost', 'u', 'b']);
    session.reconcile([
      a,
      { jobId: 'ghost', disposition: 'missing' },
      { jobId: 'u', disposition: 'unknown' },
      admitted('b', [], false),
    ]);
    selectTestProgress(session);
    session.deliverTerminal(a);
    expect(session.remaining()).toEqual(['u', 'b']);
    expect(session.exitCode()).toBe(1);
    session.reconcile([admitted('a', [], true, TEST_EPOCH, true), ...session.admissions.slice(1)]);
    expect(session.exitCode()).toBe(42);
    const successful = testSession(['a', 'b']);
    successful.reconcile([a, admitted('b', [], false)]);
    selectTestProgress(successful);
    successful.deliverTerminal(a);
    expect(successful.exitCode()).toBe(75);
  });

  it('retains unknown coverage until a complete observation publishes it', () => {
    const session = testSession(['a', 'b']);
    session.reconcile([admitted('a', [], false), admitted('b', [], false)]);
    expect(session.unknownCarriers()).toEqual(['a', 'b']);
    session.observeCoverage(['a', 'b'], ['b'], 9);
    expect(session.unknownCarriers()).toEqual(['b']);
    session.observeAbsent('b', 10);
    expect(session.remaining()).toEqual(['a', 'b']);
    expect(session.exitCode()).toBe(75);
  });
});

it('delivers a retained terminal from a previous store epoch without its progress', () => {
  const h = admitted('h', [[1, 'retained progress']], true, 'old');
  const detail = h.detail;
  detail.status.updatedAt = '2026-10-04T00:00:00Z';
  detail.exit!.endTime = detail.status.updatedAt;
  for (const event of detail.events) {
    event.ts = detail.status.updatedAt;
    event.sessionId = detail.status.sessionId;
  }
  const location = {
    version: 'v1',
    jobId: 'h',
    epochKey: 'old',
    subject: { projectRoot: '/tmp', workDir: '/tmp', jobKind: 'provider' },
    disposition: 'terminal',
    terminalSeq: 1000,
    detail: { kind: 'recorded', value: detail },
  };
  const reader = new JobAddressing(
    { time: createRealTimePort(), read: () => location, unknownLocationHolds: () => [] } as never,
    {
      visitProgress: progressVisitFromDetails(() => detail),
      epochKey: () => 'active',
      detail: () => null,
    } as never,
    () => false,
    () => 'decided',
    () => ({ kind: 'unreadable', disposition: 'retired', retired: true }),
    () => ({ kind: 'retained-away', retentionDays: 14 }),
  );
  const snapshot = reader.snapshot({ jobIds: ['h'], projectRoot: '/tmp' });
  expect(snapshot.jobs[0].progress).toEqual([]);
  expect(snapshot.notices).toContain('Progress from a previous store epoch is not shown for h.');
  expect(snapshot.jobs[0].terminal).toBeDefined();
  expect(snapshot.remainingJobIds).toEqual([]);
});

it('holds the watermark at its saved position while discovery is unknown, and keeps a pending artifact', () => {
  const a = admitted('A');
  a.availability = { kind: 'pending' };
  const session = testSession(['A'], savedCursor(1000));
  session.reconcile([{ jobId: 'A', disposition: 'unknown' }]);
  expect(session.cursor()).toBe(savedCursor(1000));
  session.reconcile([a]);
  selectTestProgress(session);
  expect(session.terminalDelivery(a)).toBe('repeat');
  session.deliverTerminal(a);
  expect(session.remaining()).toEqual(['A']);
});

it('a budget deferral preserves the previous admission', () => {
  const previous: WaitAdmission = admitted('a', [], false);
  const session = testSession(['a']);
  session.reconcile([previous]);
  session.reconcile([{ jobId: 'a', disposition: 'unknown', observationDeferred: true }]);
  expect(session.admissions).toEqual([previous]);
  expect(session.notices.filter((notice) => notice.includes('held'))).toEqual([]);
});

describe('progress source faults are attributed per job', () => {
  const timing = { origin: 'runtime' as const, originAt: '', emittedAt: '', elapsedMs: 0 };
  type Row = { seq: number; message?: string } | 'fault';
  const visitRows =
    (rows: Record<string, Row[]>): ProgressVisit =>
    (_epoch, read) => {
      const raw = (id: string): WaitProgressRow[] =>
        (rows[id] ?? []).map((row, index) => {
          if (row === 'fault') return { seq: 50 + index };
          return { seq: row.seq, message: row.message ?? `${id}-${row.seq}`, timing };
        });
      return {
        kind: 'read',
        value: read({
          frontier: () =>
            Math.max(
              0,
              ...Object.values(rows).flatMap((list) =>
                list.map((row, index) => (typeof row === 'object' ? row.seq : 50 + index)),
              ),
            ),
          after: (id, after, count) =>
            raw(id)
              .filter((row) => row.seq > after)
              .slice(0, count),
          newest: (id, count) => raw(id).slice(-count),
        }),
      };
    };
  const select = (session: WaitSession, visit: ProgressVisit) =>
    session.withProgress(visit, (source) => {
      const selected = session.select(source, { lines: 500, bytes: 65536 }, null);
      session.commit(selected);
      return selected;
    });

  it('propagates a code defect instead of holding the job behind it', () => {
    const session = testSession(['a']);
    session.reconcile([admitted('a', [], false)]);
    const defect: ProgressVisit = (_epoch, read) => ({
      kind: 'read',
      value: read({
        frontier: () => 0,
        after: () => {
          throw new TypeError('defect');
        },
        newest: () => [],
      }),
    });
    expect(() => select(session, defect)).toThrow(TypeError);
  });

  it('skips fault rows in order and moves past them like any consumed row', () => {
    const rows = { a: [{ seq: 5 }, 'fault', 'fault', 'fault'] as Row[] };
    const session = testSession(['a'], savedCursor(5));
    session.reconcile([admitted('a', [], false)]);
    const first = select(session, visitRows(rows));
    expect(first.rows).toEqual([]);
    expect(session.cursor()).toBe(savedCursor(53));
    expect(session.progressState('a')).toBe('exhausted');
  });
});

it.each([undefined, savedCursor(10)])(
  'holds an unpositioned requested member at input %s until it resolves',
  (cursor) => {
    const a = admitted('a', [[100, 'a100']], false);
    const first = testSession(['a', 'u'], cursor);
    first.reconcile([a, { jobId: 'u', disposition: 'unknown', epochKey: TEST_EPOCH }]);
    const snapshot = selectWaitSnapshot(first);
    expect(snapshot.jobs[0].progress).toEqual(['a100']);
    expect(snapshot.cursor).toBe(cursor ?? null);
    const next = testSession(['a', 'u'], snapshot.cursor ?? undefined);
    next.reconcile([a, admitted('u', [[50, 'u50']], false)]);
    expect(selectWaitSnapshot(next).jobs[1].progress).toEqual(['u50']);
  },
);

it.each(['missing', 'historical', 'lost'] as const)('a %s member does not hold the watermark', (kind) => {
  const session = testSession(['a', 'u']);
  session.reconcile([
    admitted('a', [[100, 'a100']], false),
    kind === 'historical'
      ? { ...admitted('u'), historical: true }
      : kind === 'lost'
        ? admitted('u', [], false)
        : { jobId: 'u', disposition: kind },
  ]);
  observeWaitRead(() => session.admissions)();
  session.withProgress(
    (epoch, read) =>
      testProgressVisit(epoch, (source) =>
        read({
          ...source,
          newest: (jobId, count) => {
            if (kind === 'lost' && jobId === 'u') throw new HistoricalDecodeError('undecodable progress');
            return source.newest(jobId, count);
          },
        }),
      ),
    (source) => {
      const selected = session.select(source, { lines: 500, bytes: 65536 }, 20);
      session.commit(selected);
    },
  );
  expect(session.cursor()).toBe(savedCursor(100));
});

it('reports the exact complete lines and bytes omitted from a forced 501-line event', () => {
  const lines = Array.from({ length: 501 }, (_, i) => `line ${i}`);
  const session = testSession(['a'], savedCursor(0));
  session.reconcile([admitted('a', [[1, lines.join('\n')]])]);
  const snapshot = selectWaitSnapshot(session);
  expect(snapshot.jobs[0].progress).toHaveLength(500);
  expect(snapshot.jobs[0].progress.at(-1)).toBe('line 499[event shortened: 1 lines, 9 bytes omitted]');
  expect(snapshot.cursor).toBe(savedCursor(1000));
  expect(snapshot.jobs[0].terminal).toBeDefined();
});

it('takes the end of a multiline event for a first-read tail and marks earlier omitted lines', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `tail line ${i}`);
  const session = testSession(['a']);
  session.reconcile([admitted('a', [[1, lines.join('\n')]], false)]);
  const snapshot = selectWaitSnapshot(session, 20);
  expect(snapshot.jobs[0].progress).toHaveLength(20);
  expect(snapshot.jobs[0].progress[0]).toBe('[earlier progress omitted: 20 lines, 250 bytes]tail line 20');
  expect(snapshot.jobs[0].progress.slice(1)).toEqual(lines.slice(21));
});

it('holds a fresh member whose progress page fails transiently until its seq-50 row can be read', () => {
  const a = admitted('a', [[100, 'a100']], false);
  const u = admitted('u', [[50, 'u50']], false);
  const session = testSession(['a', 'u']);
  session.reconcile([a, u]);
  observeWaitRead(() => session.admissions)();
  session.withProgress(
    (epoch, read) =>
      testProgressVisit(epoch, (source) =>
        read({
          ...source,
          newest: (jobId, count) => {
            if (jobId === 'u') throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
            return source.newest(jobId, count);
          },
        }),
      ),
    (source) => {
      const selected = session.select(source, { lines: 500, bytes: 65536 }, 20);
      session.commit(selected);
      expect(texts(selected.rows)).toEqual(['a100']);
    },
  );
  expect(session.cursor()).toBeNull();
  const resumed = testSession(['a', 'u'], session.cursor() ?? undefined);
  resumed.reconcile([a, u]);
  expect(selectWaitSnapshot(resumed).jobs[1].progress).toEqual(['u50']);
});

it('counts omitted bytes from original long lines rather than their shortened representations', () => {
  const session = testSession(['a'], savedCursor(0));
  session.reconcile([admitted('a', [[1, Array.from({ length: 501 }, () => 'x'.repeat(5000)).join('\n')]])]);
  const snapshot = selectWaitSnapshot(session);
  expect(snapshot.jobs[0].progress).toHaveLength(17);
  expect(snapshot.jobs[0].progress.at(-1)).toBe(
    'x'.repeat(864) + '[event shortened: 484 lines, 2424620 bytes omitted]',
  );
});

it('keeps the single-line shortening marker when a tail share forces an over-long line to fit', () => {
  const jobs = Array.from({ length: 128 }, (_, i) => admitted(`a${i}`, [[i + 1, 'x'.repeat(5000)]], false));
  const session = testSession(jobs.map((job) => job.jobId));
  session.reconcile(jobs);
  const snapshot = selectWaitSnapshot(session);
  expect(snapshot.jobs[0].progress).toEqual(['x'.repeat(416) + '[line shortened: 4584 bytes omitted]']);
});
