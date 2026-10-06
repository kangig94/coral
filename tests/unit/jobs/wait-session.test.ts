import {
  observeWaitRead,
  progressVisitFromDetails,
  selectTestProgress,
  testProgressVisit,
} from '#tests/helpers/wait-progress.js';
import type { ProgressVisit, WaitProgressRow } from '#src/jobs/wait/contract.js';
import { HistoricalDecodeError } from '#src/jobs/source-read.js';
import type { JobLocation, JobLocationView } from '#src/jobs/location-index.js';
import type { WaitStreamEvent, WaitCursor } from '#src/jobs/wait/contract.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { createRealTimePort } from '#src/infra/time.js';
import { admitted, savedCursor } from '#tests/helpers/wait-session.js';
import { describe, expect, it, vi } from 'vitest';
import { WaitSession, type WaitAdmission } from '#src/jobs/wait/session.js';
import { waitJobHash } from '#src/jobs/wait/cursor.js';
import { selectWaitSnapshot } from '#tests/helpers/wait-progress.js';

const texts = (rows: ReadonlyArray<{ message: string }>) => rows.map((row) => row.message);

describe('wait session', () => {
  it('sorts unknown carrier IDs independently of admission order', () => {
    const session = new WaitSession(['z', 'a']);
    session.reconcile([admitted('z', [], false), admitted('a', [], false)]);
    expect(session.unknownCarriers()).toEqual(['a', 'z']);
  });

  it('consumes each job by its own seq, so a cut resumes every job where it stopped in any order', () => {
    const session = new WaitSession(['a', 'b']);
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
    const resumed = new WaitSession(['b', 'a'], session.cursor());
    resumed.reconcile([...session.admissions].reverse());
    expect(texts(selectTestProgress(resumed))).toEqual(['b2', 'a3', 'b4']);
    expect(resumed.notices).toEqual([]);
  });

  it('treats a job whose cursor seq reached its terminal seq as already collected', () => {
    const a = admitted('a', [[1, 'a1']]);
    const fresh = new WaitSession(['a']);
    fresh.reconcile([a]);
    expect(fresh.collected(a)).toBe(false);
    const resumed = new WaitSession(['a'], savedCursor({ a: 1000 }));
    resumed.reconcile([a]);
    expect(resumed.collected(a)).toBe(true);
    expect(resumed.remaining()).toEqual([]);
    const behind = new WaitSession(['a'], savedCursor({ a: 999 }));
    behind.reconcile([a]);
    expect(behind.collected(a)).toBe(false);
  });

  it('keeps a collected job in the continuation while its artifact is pending, and releases it once settled', () => {
    const a = admitted('a', [[1, 'one\ntwo\n']]);
    a.availability = { kind: 'pending' };
    const session = new WaitSession(['a']);
    session.reconcile([a]);
    selectTestProgress(session);
    expect(session.terminalDeliverable(a)).toBe(true);
    session.collect(a);
    expect(session.remaining()).toEqual(['a']);
    const resumed = new WaitSession(['a'], session.cursor(session.remaining()));
    resumed.reconcile([a]);
    expect(resumed.collected(a)).toBe(true);
    expect(resumed.remaining()).toEqual(['a']);
    resumed.reconcile([{ ...a, availability: { kind: 'available', resultPath: '/results/a' } }]);
    expect(resumed.remaining()).toEqual([]);
  });

  it('gives a member the cursor never positioned its own tail on its first readable visit', () => {
    const a = admitted('a', [[100, 'a100']]);
    const session = new WaitSession(['a', 'u']);
    session.reconcile([a, { jobId: 'u', disposition: 'unknown' }]);
    const cursor = selectWaitSnapshot(session, 20).cursor;
    expect(cursor.jobs.map((job) => job.hash)).toEqual([]);
    const resumed = new WaitSession(['a', 'u'], cursor);
    resumed.reconcile([a, admitted('u', [[2, 'u below 100']], false)]);
    expect(selectWaitSnapshot(resumed, 20).jobs[1].progress).toEqual(['u below 100']);
    expect(resumed.collected(a)).toBe(true);
  });

  it('uses request-order failure and refusal precedence; excludes missing but retains retryable discovery', () => {
    const a = admitted('a');
    const session = new WaitSession(['a', 'ghost', 'u', 'b']);
    session.reconcile([
      a,
      { jobId: 'ghost', disposition: 'missing' },
      { jobId: 'u', disposition: 'unknown' },
      admitted('b', [], false),
    ]);
    selectTestProgress(session);
    session.collect(a);
    expect(session.remaining()).toEqual(['u', 'b']);
    expect(session.cursor(session.remaining()).jobs.map((job) => job.hash)).toEqual([waitJobHash('b')]);
    expect(session.exitCode()).toBe(1);
    session.reconcile([admitted('a', [], true, 'epoch-E', true), ...session.admissions.slice(1)]);
    expect(session.exitCode()).toBe(42);
    const successful = new WaitSession(['a', 'b']);
    successful.reconcile([a, admitted('b', [], false)]);
    successful.collect(a);
    expect(successful.exitCode()).toBe(75);
  });

  it('retains unknown coverage until a complete observation publishes it', () => {
    const session = new WaitSession(['a', 'b']);
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

it.each([
  ['a', 'b'],
  ['b', 'a'],
])('internal replacement membership %j preserves the sibling frontier', (...jobIds) => {
  const session = new WaitSession(jobIds, savedCursor({ a: 10 }), true);
  session.reconcile(
    jobIds.map((id) =>
      admitted(
        id,
        id === 'a'
          ? [
              [5, 'old sibling'],
              [10, 'consumed sibling'],
            ]
          : [[11, 'new member']],
        false,
        'real-epoch',
      ),
    ),
  );
  expect(texts(selectTestProgress(session))).toEqual(['new member']);
  expect(session.notices).toEqual([]);
});

it('never splits consumed history again on later polls', () => {
  const jobs = Array.from({ length: 32 }, (_, i) =>
    admitted(
      `cost-${i}`,
      Array.from({ length: 5000 }, (_, n) => [n + 1, 'cost line'] as [number, string]),
      false,
    ),
  );
  const session = new WaitSession(
    jobs.map((job) => job.jobId),
    savedCursor(Object.fromEntries(jobs.map((job) => [job.jobId, 4999]))),
  );
  const split = vi.spyOn(String.prototype, 'split');
  try {
    for (let poll = 0; poll < 20; poll++) {
      session.reconcile(jobs);
      selectTestProgress(session);
      session.remaining();
      session.cursor();
    }
    expect(split.mock.calls.filter((call) => (call[0] as unknown) === '\n').length).toBe(32);
  } finally {
    split.mockRestore();
  }
});

it('keeps a job whose discovery is unknown in the continuation while its sibling progress is delivered', () => {
  const b = admitted('b', [[5, 'sibling backlog']]);
  const session = new WaitSession(['a', 'b']);
  session.reconcile([{ jobId: 'a', disposition: 'unknown', message: 'retry' }, b]);
  const first = selectWaitSnapshot(session, 20);
  expect(first.jobs[1].progress).toEqual(['sibling backlog']);
  expect(first.remainingJobIds).toEqual(['a']);
  expect(first.cursor.jobs).toEqual([]);
  const resumed = new WaitSession(first.remainingJobIds, first.cursor);
  resumed.reconcile([admitted('a', [[3, 'recovered backlog']])]);
  const next = selectWaitSnapshot(resumed);
  expect(next.jobs.map((job) => job.progress)).toEqual([['recovered backlog']]);
  expect(next.remainingJobIds).toEqual([]);
});

it.each([
  ['unknown', ['U']],
  ['historical', []],
] as const)('keeps sibling progress and settles a %s member after its outcome delivery', (state, remaining) => {
  const a = admitted(
    'A',
    [
      [10, 'a-ten'],
      [11, 'a-eleven'],
    ],
    true,
    'epoch-H',
  );
  const u: WaitAdmission =
    state === 'unknown'
      ? { jobId: 'U', disposition: 'unknown', message: 'retry' }
      : { ...admitted('U', [], true, 'epoch-H'), historical: true };
  const session = new WaitSession(['A', 'U']);
  session.reconcile([a, u]);
  expect(texts(selectTestProgress(session))).toEqual(['a-ten', 'a-eleven']);
  session.collect(a);
  if (session.terminalDeliverable(u)) session.collect(u);
  expect(session.remaining()).toEqual(remaining);
});

it('keeps a known cursor entry while discovery is unknown', () => {
  const a = admitted('A');
  a.availability = { kind: 'pending' };
  const session = new WaitSession(['A']);
  session.reconcile([a]);
  session.collect(a);
  const saved = session.cursor();
  session.reconcile([{ jobId: 'A', disposition: 'unknown' }]);
  expect(session.cursor()).toEqual(saved);
  const next = new WaitSession(['A'], session.cursor());
  next.reconcile([a]);
  expect(next.collected(a)).toBe(true);
  expect(next.remaining()).toEqual(['A']);
});

describe('addressing discovery retry preserves interleaved progress', () => {
  const E = 'epoch-E';
  function loc(jobId: string): JobLocation {
    return {
      version: 'v1',
      jobId,
      epochKey: E,
      subject: { projectRoot: '/tmp', workDir: '/tmp', jobKind: 'provider' },
      disposition: 'active-owner',
      detail: { kind: 'absent' },
    } as JobLocation;
  }

  it('preserves unread progress after one EMFILE on a member location read (production addressing path)', async () => {
    let now = 0n;
    let failB = 0;
    const view: JobLocationView = {
      time: {
        ...createRealTimePort(),
        monotonicNow: () => now,
        sleep: async (ms: number) => {
          now += BigInt(ms);
        },
      },
      read: (jobId) => {
        if (jobId === 'b' && failB++ === 1)
          throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
        return loc(jobId);
      },
      resultPathFor: (jobId) => `/r/${jobId}`,
      unknownLocationHolds: () => [],
    };
    const a = admitted(
      'a',
      [
        [7, 'a-7'],
        [8, 'a-8'],
      ],
      false,
    );
    const b = admitted(
      'b',
      [
        [5, 'b-5'],
        [6, 'b-6'],
      ],
      false,
    );
    const addressing = new JobAddressing(
      view,
      {
        visitProgress: progressVisitFromDetails((id) => (id === 'a' ? a.detail : b.detail)),
        epochKey: () => E,
        detail: () => null,
        readWaitAdmissions: (ids) => ids.map((id) => (id === 'a' ? a : b)),
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
      },
      () => false,
      () => 'pending',
      undefined,
      () => ({ kind: 'available', resultPath: '/r/x' }),
    );
    const cursor: WaitCursor = savedCursor({ a: 4, b: 4 });
    const events: WaitStreamEvent[] = [];
    // The stream's second poll fails b's location read once.
    for await (const e of addressing.waitStream({
      jobIds: ['a', 'b'],
      timeoutSeconds: 1,
      cursor,
      projectRoot: '/tmp',
    }))
      events.push(e);
    const lines = events.flatMap((e) =>
      e.type === 'progress' ? [e.message] : e.type === 'disposition' ? [`<${e.jobId}:${e.disposition}>`] : [],
    );

    expect(lines).toContain('b-5');
  });
});

it('reads one source for two addresses of one lineage without duplicate progress', () => {
  const one = JSON.stringify({ storeRoot: '/x', epoch: '1', path: '/x/epoch-1/store.db', lineageKey: 'L:1' });
  const two = JSON.stringify({ storeRoot: '/y', epoch: '1', path: '/y/epoch-1/store.db', lineageKey: 'L:1' });
  const session = new WaitSession(['a', 'b']);
  session.reconcile([
    admitted(
      'a',
      [
        [1, 'a1'],
        [3, 'a3'],
      ],
      false,
      one,
    ),
    admitted('b', [[2, 'b2']], false, two),
  ]);
  let visits = 0;
  observeWaitRead(() => session.admissions)();
  const selected = session.withProgress(
    (epoch, read) => {
      visits++;
      return testProgressVisit(epoch, read);
    },
    (sources) => session.select(sources, { lines: 500, bytes: 65536 }, null),
  );
  expect(texts(selected.rows)).toEqual(['a1', 'b2', 'a3']);
  expect(visits).toBe(1);
});

it.each(['admitted', 'missing', 'scope-mismatch', 'unknown'] as const)(
  'a budget deferral preserves previous %s admission',
  (disposition) => {
    const previous: WaitAdmission = disposition === 'admitted' ? admitted('a', [], false) : { jobId: 'a', disposition };
    const session = new WaitSession(['a']);
    session.reconcile([previous]);
    session.reconcile([{ jobId: 'a', disposition: 'unknown', observationDeferred: true }]);
    expect(session.admissions).toEqual([previous]);
    expect(session.notices.filter((notice) => notice.includes('held'))).toEqual([]);
  },
);

it("reads each job's newest rows with one query on its first visit, capped so the union fits the budget", () => {
  const jobs = Array.from({ length: 128 }, (_, index) => admitted(`job-${index}`, [], false));
  const timing = { origin: 'runtime' as const, originAt: '', emittedAt: '', elapsedMs: 0 };
  const rows: WaitProgressRow[] = Array.from({ length: 100 }, (_, index) => ({
    seq: index + 1,
    message: `line-${index}`,
    timing,
  }));
  const queries: string[] = [];
  const session = new WaitSession(jobs.map((job) => job.jobId));
  session.reconcile(jobs);
  const selected = session.withProgress(
    (_epoch, visit) => ({
      kind: 'read',
      value: visit({
        after: () => {
          queries.push('after');
          return [];
        },
        newest: (_id, count) => {
          queries.push('newest');
          return rows.slice(-count);
        },
      }),
    }),
    (sources) => session.select(sources, { lines: 500, bytes: 65536 }, 20),
  );
  session.commit(selected);
  expect(queries).toEqual(Array.from({ length: 128 }, () => 'newest'));
  expect(selected.rows).toHaveLength(128 * 3);
  expect(selected.rows.reduce((sum, row) => sum + row.lines, 0)).toBeLessThanOrEqual(500);
  expect(session.cursor().jobs.every((entry) => entry.seq === 100)).toBe(true);
  expect(session.hasProgress()).toBe(false);
});

it('shortens one row larger than an empty budget instead of holding it back', () => {
  const session = new WaitSession(['a'], savedCursor({ a: 0 }));
  session.reconcile([admitted('a', [[1, Array.from({ length: 600 }, (_, n) => `l${n}`).join('\n')]], false)]);
  observeWaitRead(() => session.admissions)();
  const { rows } = session.withProgress(testProgressVisit, (sources) => {
    const selected = session.select(sources, { lines: 500, bytes: 65536 }, null);
    session.commit(selected);
    return selected;
  });
  expect(rows).toHaveLength(1);
  expect(rows[0].lines).toBe(500);
  expect(rows[0].message.split('\n').at(-1)).toMatch(/^l499\[line shortened: \d+ bytes omitted\]$/);
  expect(session.cursor().jobs[0].seq).toBe(1);
});

describe('progress source faults are attributed per job', () => {
  const timing = { origin: 'runtime' as const, originAt: '', emittedAt: '', elapsedMs: 0 };
  type Row = { seq: number; message?: string } | 'undecodable' | 'fault';
  const visitRows =
    (rows: Record<string, Row[]>, onVisit?: () => void): ProgressVisit =>
    (epoch, read) => {
      onVisit?.();
      const raw = (id: string): WaitProgressRow[] =>
        (rows[id] ?? []).map((row, index) => {
          if (row === 'undecodable') throw new HistoricalDecodeError(`row ${index} of ${id} in ${epoch}`);
          if (row === 'fault') return { seq: 50 + index };
          return { seq: row.seq, message: row.message ?? `${id}-${row.seq}`, timing };
        });
      return {
        kind: 'read',
        value: read({
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
    const session = new WaitSession(['a1', 'b1']);
    session.reconcile([admitted('a1', [], true, 'epoch-E1'), admitted('b1', [], true, 'epoch-E2')]);
    const selected = select(session, visitRows({ a1: [{ seq: 5 }, 'undecodable'], b1: [{ seq: 7 }, { seq: 8 }] }));
    expect(texts(selected.rows)).toEqual(['b1-7', 'b1-8']);
    expect(session.progressState('a1')).toBe('lost');
    expect(session.notices.join(' ')).toContain('Earlier progress for a1 cannot be read by this build');
    expect(session.notices.join(' ')).not.toContain('b1 cannot be read');
  });

  it('visits each epoch once however many epochs hold a failing job', () => {
    const ids = Array.from({ length: 18 }, (_, index) => `job-${index}`);
    const session = new WaitSession(ids);
    session.reconcile(ids.map((id, index) => admitted(id, [], false, `epoch-${index}`)));
    let visits = 0;
    select(
      session,
      visitRows(
        Object.fromEntries(ids.map((id) => [id, id === 'job-0' ? ['undecodable' as const] : [{ seq: 5 }]])),
        () => visits++,
      ),
    );
    expect(visits).toBe(18);
    expect(ids.slice(1).every((id) => session.progressState(id) !== 'lost')).toBe(true);
  });

  it('propagates a code defect instead of holding the job behind it', () => {
    const session = new WaitSession(['a']);
    session.reconcile([admitted('a', [], false)]);
    const defect: ProgressVisit = (_epoch, read) => ({
      kind: 'read',
      value: read({
        after: () => {
          throw new TypeError('defect');
        },
        newest: () => [],
      }),
    });
    expect(() => select(session, defect)).toThrow(TypeError);
  });

  it('holds only the job whose page read failed transiently', () => {
    const session = new WaitSession(['a', 'b']);
    session.reconcile([admitted('a', [], false, 'epoch-E1'), admitted('b', [[3, 'b-3']], false, 'epoch-E2')]);
    const busy: ProgressVisit = (epoch, read) =>
      epoch === 'epoch-E1'
        ? {
            kind: 'read',
            value: read({
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

  it('says a retired source no longer keeps the progress', () => {
    const session = new WaitSession(['a']);
    session.reconcile([admitted('a', [], true, 'epoch-OLD')]);
    session.withProgress(
      () => ({ kind: 'unreadable', disposition: 'retired' }),
      () => undefined,
    );
    expect(session.notices.join(' ')).toContain('Earlier progress for a is no longer kept');
    expect(session.notices.join(' ')).not.toContain('cannot be read by this build');
  });

  it('skips fault rows in order and moves past them like any consumed row', () => {
    const rows = { a: [{ seq: 5 }, 'fault', 'fault', 'fault'] as Row[] };
    const session = new WaitSession(['a'], savedCursor({ a: 5 }));
    session.reconcile([admitted('a', [], false)]);
    const first = select(session, visitRows(rows));
    expect(first.rows).toEqual([]);
    expect(session.cursor().jobs[0].seq).toBe(53);
    expect(session.progressState('a')).toBe('exhausted');
  });
});

describe('only admitted members hold progress (K3)', () => {
  it('does not report truncated progress for a refused sibling', () => {
    const session = new WaitSession(['a', 'ghost']);
    session.reconcile([admitted('a', [[1, 'only line']], false), { jobId: 'ghost', disposition: 'missing' }]);
    expect(session.progressState('ghost')).toBe('refused');
    const snapshot = selectWaitSnapshot(session, 20);
    expect(snapshot.notices.some((notice) => notice.startsWith('Progress truncated'))).toBe(false);
    expect(session.hasProgress()).toBe(false);
  });
});

it('gives each job a share of the page so a chatty job cannot starve its sibling', () => {
  const chatty = admitted(
    'chatty',
    Array.from({ length: 600 }, (_, index) => [index + 1, `c-${index}`] as [number, string]),
    false,
    'epoch-E1',
  );
  const quiet = admitted('quiet', [[700, 'q-700']], false, 'epoch-E2');
  const session = new WaitSession(['chatty', 'quiet'], savedCursor({ chatty: 0, quiet: 0 }));
  session.reconcile([chatty, quiet]);
  expect(texts(selectTestProgress(session, 500))).toContain('q-700');
});

it('selects each line once when a deferred member keeps an older alias of the same epoch', () => {
  const s1 = JSON.stringify({ storeRoot: '/a', epoch: '1', path: '/a/epoch-1/store.db', lineageKey: 'L:1' });
  const s2 = JSON.stringify({ storeRoot: '/b', epoch: '1', path: '/b/epoch-1/store.db', lineageKey: 'L:1' });
  const session = new WaitSession(['j1', 'j2']);
  const j1 = admitted('j1', [[1, 'j1 line']], false, s1);
  const j2 = admitted('j2', [[2, 'j2 line']], false, s2);
  session.reconcile([j1, j2]);
  session.reconcile([{ jobId: 'j1', disposition: 'unknown', observationDeferred: true }, j2]);
  observeWaitRead(() => [j1, j2])();
  expect(texts(selectTestProgress(session))).toEqual(['j1 line', 'j2 line']);
});
