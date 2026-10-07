import {
  observeWaitRead,
  progressVisitFromDetails,
  selectTestProgress,
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
      return session.withProgress(testProgressVisit, (sources) => {
        const selected = session.select(sources, { lines: 500, bytes: 65536 }, null);
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
  type Row = { seq: number; message?: string } | 'undecodable' | 'fault';
  const visitRows =
    (rows: Record<string, Row[]>): ProgressVisit =>
    (epoch, read) => {
      const raw = (id: string): WaitProgressRow[] =>
        (rows[id] ?? []).map((row, index) => {
          if (row === 'undecodable') throw new HistoricalDecodeError(`row ${index} of ${id} in ${epoch}`);
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
    session.withProgress(visit, (sources) => {
      const selected = session.select(sources, { lines: 500, bytes: 65536 }, null);
      session.commit(selected);
      return selected;
    });

  it('settles only the job whose row failed to decode and keeps its other-epoch sibling readable', () => {
    const session = testSession(['a1', 'b1']);
    session.reconcile([admitted('a1', [], true, 'epoch-E1'), admitted('b1', [], true, 'epoch-E2')]);
    const selected = select(session, visitRows({ a1: [{ seq: 5 }, 'undecodable'], b1: [{ seq: 7 }, { seq: 8 }] }));
    expect(texts(selected.rows)).toEqual(['b1-7', 'b1-8']);
    expect(session.progressState('a1')).toBe('lost');
    expect(session.notices.join(' ')).toContain('Earlier progress for a1 cannot be read by this build');
    expect(session.notices.join(' ')).not.toContain('b1 cannot be read');
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

  it('holds only the job whose page read failed transiently', () => {
    const session = testSession(['a', 'b']);
    session.reconcile([admitted('a', [], false, 'epoch-E1'), admitted('b', [[3, 'b-3']], false, 'epoch-E2')]);
    const busy: ProgressVisit = (epoch, read) =>
      epoch === 'epoch-E1'
        ? {
            kind: 'read',
            value: read({
              frontier: () => 0,
              after: () => {
                throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
              },
              newest: () => [],
            }),
          }
        : testProgressVisit(epoch, read);
    observeWaitRead(() => session.admissions)();
    const selected = select(session, busy);
    expect(texts(selected.rows)).toEqual(['b-3']);
    expect(session.progressState('a')).toBe('unknown');
    expect(session.remaining()).toContain('a');
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
