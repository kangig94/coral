import { progressPage, progressTail } from '#src/jobs/wait/progress-page.js';
import {
  observeWaitRead,
  progressVisitFromDetails,
  selectTestProgress,
  testProgressVisit,
} from '#tests/helpers/wait-progress.js';
import type { ProgressVisit } from '#src/jobs/wait/contract.js';
import { HistoricalDecodeError } from '#src/jobs/source-read.js';
import type { JobLocation, JobLocationView } from '#src/jobs/location-index.js';
import type { WaitStreamEvent, WaitCursor } from '#src/jobs/wait/contract.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { createRealTimePort } from '#src/infra/time.js';
import { admitted } from '#tests/helpers/wait-session.js';
import { describe, expect, it, vi } from 'vitest';
import { WaitSession, type SourceReadDisposition } from '#src/jobs/wait/session.js';
import { waitEpochToken, waitJobHash } from '#src/jobs/wait/cursor.js';
import { selectWaitSnapshot } from '#tests/helpers/wait-progress.js';

describe('wait session', () => {
  it('rejects identical repeated job IDs before constructing a cursor', () => {
    expect(() => new WaitSession(['a', 'a'])).toThrow('Each job ID must appear only once');
  });

  it('sorts unknown carrier IDs independently of admission order', () => {
    const session = new WaitSession(['z', 'a']);
    session.reconcile([admitted('z', [], false), admitted('a', [], false)]);
    expect(session.unknownCarriers()).toEqual(['a', 'z']);
  });

  it('consumes an epoch prefix without skipping an interleaved sibling or hiding its terminal', () => {
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
    session.consume(selectTestProgress(session)[0]);
    expect(selectTestProgress(session).map((line) => line.text)).toEqual(['b2', 'a3', 'b4']);
    session.acknowledge(session.admissions[0]);
    expect(session.remaining()).toEqual(['a', 'b']);
    const resumed = new WaitSession(['b', 'a'], session.cursor());
    resumed.reconcile([...session.admissions].reverse());
    expect(selectTestProgress(resumed).map((line) => line.text)).toEqual(['b2', 'a3', 'b4']);
    expect(resumed.acknowledged('a')).toBe(true);
    expect(resumed.acknowledged('b')).toBe(false);
    expect(resumed.notices).toEqual([]);
  });

  it('preserves acknowledgement and artifact settlement independently of unread progress', () => {
    const a = admitted('a', [[1, 'one\ntwo\n']]);
    a.availability = { kind: 'repair-pending', ageUncertain: false };
    const session = new WaitSession(['a']);
    session.reconcile([a]);
    session.acknowledge(a);
    expect(selectTestProgress(session).map((line) => line.text)).toEqual(['one', 'two']);
    session.consume(selectTestProgress(session)[0]);
    const resumed = new WaitSession(['a'], session.cursor());
    resumed.reconcile([a]);
    expect(selectTestProgress(resumed).map((line) => line.text)).toEqual(['two']);
    expect(resumed.acknowledged('a')).toBe(true);
    expect(resumed.artifactPending('a')).toBe(true);
    expect(resumed.remaining()).toEqual(['a']);
    resumed.consume(selectTestProgress(resumed)[0]);
    expect(resumed.remaining()).toEqual(['a']);
    resumed.settleArtifact('a');
    expect(resumed.remaining()).toEqual([]);
  });

  it.each(['snapshot-to-stream', 'stream-to-snapshot'])(
    'positions a resolved member independently on %s without losing flags',
    (direction) => {
      const a = admitted('a', [[100, 'a100']]);
      a.availability = { kind: 'repair-pending', ageUncertain: false };
      const session = new WaitSession(['a', 'u']);
      session.reconcile([a, { jobId: 'u', disposition: 'discovery-unknown' }]);
      const cursor =
        direction === 'snapshot-to-stream'
          ? selectWaitSnapshot(session, 20).cursor
          : (() => {
              session.consume(selectTestProgress(session)[0]);
              session.acknowledge(a);
              return session.cursor();
            })();
      expect(cursor.jobs.find((job) => job.hash === waitJobHash('u'))).toMatchObject({ epoch: null, flags: 4 });
      const joined = [a, admitted('u', [[2, 'u below 100']], false)];
      const resumed = new WaitSession(['a', 'u'], cursor);
      resumed.reconcile(joined);
      expect(selectTestProgress(resumed).map((line) => line.text)).toEqual(['u below 100']);
      expect(resumed.notices.some((notice) => notice.includes('membership changed'))).toBe(false);
      expect(resumed.acknowledged('a')).toBe(true);
      expect(resumed.artifactPending('a')).toBe(true);
      const next = new WaitSession(['u', 'a'], resumed.cursor());
      next.reconcile([...joined].reverse());
      expect(next.notices).toEqual([]);
      expect(next.acknowledged('a')).toBe(true);
    },
  );

  it('uses request-order failure and refusal precedence; excludes missing but retains retryable discovery', () => {
    const a = admitted('a');
    const session = new WaitSession(['a', 'ghost', 'u', 'b']);
    session.reconcile([
      a,
      { jobId: 'ghost', disposition: 'missing' },
      { jobId: 'u', disposition: 'discovery-unknown' },
      admitted('b', [], false),
    ]);
    selectTestProgress(session);
    session.acknowledge(a);
    expect(session.remaining()).toEqual(['u', 'b']);
    expect(session.cursor(session.remaining()).jobs).toHaveLength(2);
    expect(session.exitCode()).toBe(1);
    session.reconcile([admitted('a', [], true, 'epoch-E', true), ...session.admissions.slice(1)]);
    expect(session.exitCode()).toBe(42);
    const successful = new WaitSession(['a', 'b']);
    successful.reconcile([a, admitted('b', [], false)]);
    successful.acknowledge(a);
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
    expect(session.cursor().jobs[0].epoch).toBe(waitEpochToken('epoch-E'));
  });
});

it.each([false, true])(
  'retained history cannot supply progress or an unvalidated outcome without a successful source read, corrupt=%s',
  (corrupt) => {
    const h = admitted('h', [[1, 'retained progress']], true, 'old');
    const detail = h.detail;
    detail.status.updatedAt = '2026-10-04T00:00:00Z';
    detail.exit!.endTime = detail.status.updatedAt;
    for (const event of detail.events) {
      event.ts = detail.status.updatedAt;
      event.sessionId = detail.status.sessionId;
    }
    if (corrupt) detail.exit!.content = 'corrupted copy';
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
        visitProgress: progressVisitFromDetails(() => null),
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
    if (!corrupt) expect(snapshot.notices.join(' ')).toContain('source retired');
    if (corrupt) {
      expect(snapshot.jobs[0].terminal).toBeUndefined();
      expect(snapshot.remainingJobIds).toEqual([]);
      expect(snapshot.exitCode).toBe(1);
    } else expect(snapshot.jobs[0].terminal).toBeDefined();
  },
);

it.each([
  ['a', 'b'],
  ['b', 'a'],
])('internal replacement membership %j preserves the sibling frontier', (...jobIds) => {
  const input = {
    jobs: [{ hash: waitJobHash('a'), epoch: waitEpochToken('real-epoch'), seq: 10, lineOffset: 0, flags: 0 }],
  };
  const session = new WaitSession(jobIds, input, true);
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
  expect(selectTestProgress(session).map((line) => line.text)).toEqual(['new member']);
  expect(session.notices).toEqual([]);
});

it('reuses unread progress through idle polls and never splits consumed history', () => {
  const jobs = Array.from({ length: 32 }, (_, i) =>
    admitted(
      `cost-${i}`,
      Array.from({ length: 5000 }, (_, n) => [n + 1, 'cost line'] as [number, string]),
      false,
    ),
  );
  const input = {
    jobs: jobs.map((job) => ({
      hash: waitJobHash(job.jobId),
      epoch: waitEpochToken('epoch-E'),
      seq: 4999,
      lineOffset: 0,
      flags: 0,
    })),
  };
  const session = new WaitSession(
    jobs.map((job) => job.jobId),
    input,
  );
  const split = vi.spyOn(String.prototype, 'split');
  try {
    for (let poll = 0; poll < 20; poll++) {
      session.reconcile(jobs);
      selectTestProgress(session);
      session.remaining();
      session.cursor();
    }
    expect(split.mock.calls.filter((call) => (call[0] as unknown) === '\n').length).toBe(32 * 20);
  } finally {
    split.mockRestore();
  }
});

it('holds the shared progress frontier while one member history is unreadable', () => {
  const a = admitted('a');
  a.sourceRead = 'transient-unknown';
  a.progressUnknown = true;
  const b = admitted('b', [[5, 'sibling backlog']]);
  const session = new WaitSession(['a', 'b']);
  session.reconcile([a, b]);
  const first = selectWaitSnapshot(session, 20);
  expect(first.jobs[1].progress).toEqual(['sibling backlog']);
  expect(first.remainingJobIds).toEqual(['a']);
  expect(first.cursor.jobs[0].seq).toBe(0);
  const resumed = new WaitSession(first.remainingJobIds, first.cursor);
  resumed.reconcile([admitted('a', [[3, 'recovered backlog']])]);
  const next = selectWaitSnapshot(resumed);
  expect(next.jobs.map((job) => job.progress)).toEqual([['recovered backlog']]);
  expect(next.remainingJobIds).toEqual([]);
});

it.each(['readable', 'transient-unknown', 'settled-unreadable', 'retired'] as const)(
  'keeps sibling progress and settles %s after retained outcome delivery',
  (sourceRead: SourceReadDisposition) => {
    const a = admitted(
      'A',
      [
        [10, 'a-ten'],
        [11, 'a-eleven'],
      ],
      true,
      'epoch-H',
    );
    const u = { ...admitted('U', [], true, 'epoch-H'), sourceRead };
    const session = new WaitSession(['A', 'U']);
    session.reconcile([a, u]);
    session.acknowledge(a);
    session.acknowledge(u);
    if (sourceRead === 'transient-unknown') {
      expect(selectTestProgress(session).map((line) => line.text)).toEqual(['a-ten', 'a-eleven']);
      expect(session.remaining()).toEqual(['A', 'U']);
      expect(session.notices.some((notice) => notice.includes('U') && notice.includes('is held'))).toBe(true);
      expect(session.cursor(session.remaining()).jobs[0].seq).toBe(0);
    } else {
      expect(selectTestProgress(session).map((line) => line.text)).toEqual(['a-ten', 'a-eleven']);
      expect(session.remaining()).toEqual(['A']);
      for (const line of selectTestProgress(session)) session.consume(line);
      expect(session.remaining()).toEqual([]);
    }
  },
);

it.each([false, true])('unknown discovery preserves known cursor flags, resumed=%s', (resumed) => {
  const a = admitted('A');
  a.availability = { kind: 'repair-pending', ageUncertain: false };
  const session = new WaitSession(['A']);
  session.reconcile([a]);
  session.acknowledge(a);
  const saved = session.cursor();
  const middle = resumed ? new WaitSession(['A'], saved) : session;
  middle.reconcile([{ jobId: 'A', disposition: 'discovery-unknown' }]);
  expect(middle.cursor()).toEqual(saved);
  const next = new WaitSession(['A'], middle.cursor());
  next.reconcile([a]);
  expect(next.acknowledged('A')).toBe(true);
  expect(next.artifactPending('A')).toBe(true);
  expect(next.notices).toEqual([]);
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
    const cursor: WaitCursor = {
      jobs: [
        { hash: waitJobHash('a'), epoch: waitEpochToken(E), seq: 4, lineOffset: 0, flags: 0 },
        { hash: waitJobHash('b'), epoch: waitEpochToken(E), seq: 4, lineOffset: 0, flags: 0 },
      ],
    };
    const events: WaitStreamEvent[] = [];
    // first read() is validateWait's admission (failB=0 -> ok), second is the stream's first poll (failB=1 -> EMFILE)
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

it('merges two addresses for one lineage without duplicate progress', () => {
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
  expect(selectTestProgress(session).map((line) => line.text)).toEqual(['a1', 'b2', 'a3']);
  expect(new Set(session.cursor().jobs.map((entry) => entry.epoch))).toHaveLength(1);
});

it.each(['admitted', 'missing', 'scope-mismatch', 'discovery-unknown'] as const)(
  'a budget deferral preserves previous %s admission',
  (disposition) => {
    const previous = disposition === 'admitted' ? admitted('a', [], false) : { jobId: 'a', disposition };
    const session = new WaitSession(['a']);
    session.reconcile([previous]);
    session.reconcile([{ jobId: 'a', disposition: 'discovery-unknown', observationDeferred: true }]);
    expect(session.admissions).toEqual([previous]);
    expect(session.notices.filter((notice) => notice.includes('held'))).toEqual([]);
  },
);

it('water-fills a maximum set before reading tails, within the raw-row budget', () => {
  const jobs = Array.from({ length: 128 }, (_, index) => admitted(`job-${index}`, [], false));
  const timing = { origin: 'runtime' as const, originAt: '', emittedAt: '', elapsedMs: 0 };
  let rowsRead = 0;
  const session = new WaitSession(jobs.map((job) => job.jobId));
  session.reconcile(jobs);
  const raw = Array.from({ length: 100 }, (_, index) => ({
    seq: index + 1,
    progress: { seq: index + 1, message: `line-${index}`, timing },
  }));

  session.withProgress(
    (_epoch, visit) => ({
      kind: 'read',
      value: visit({
        after: (_id, after, count) => {
          const page = raw.filter((row) => row.seq > after).slice(0, count + 1);
          rowsRead += page.length;
          return progressPage(page, count, 100);
        },
        before: (_id, before, count) => {
          const page = raw
            .filter((row) => before === null || row.seq < before)
            .slice()
            .reverse()
            .slice(0, count + 1);
          rowsRead += page.length;
          return progressTail(page, count, 100);
        },
      }),
    }),
    (sources) => {
      // Two lines and a lookahead row per tail fit 128 tails in 500 rows, and selection reuses what positioning read.
      const positioned = session.position(sources, 20, 500, 65536);
      const selected = session.select(sources, 500, 65536, positioned);
      expect(selected.lines).toHaveLength(128 * 2);
      expect(selected.cut).toBe(false);
      expect(rowsRead).toBeLessThanOrEqual(500);
      expect(session.cursor().jobs.every((entry) => entry.seq === 98)).toBe(true);
    },
  );
});

describe('progress source faults are attributed per source (K2)', () => {
  const timing = { origin: 'runtime' as const, originAt: '', emittedAt: '', elapsedMs: 0 };
  type Row = { seq: number; message?: string } | 'undecodable' | 'fault';
  const visitRows =
    (rows: Record<string, Row[]>, onVisit?: () => void, frontier = 100): ProgressVisit =>
    (epoch, read) => {
      onVisit?.();
      const raw = (id: string) =>
        (rows[id] ?? []).map((row, index) => {
          if (row === 'undecodable') throw new HistoricalDecodeError(`row ${index} of ${id} in ${epoch}`);
          if (row === 'fault') return { seq: 50 + index };
          return { seq: row.seq, progress: { seq: row.seq, message: row.message ?? `${id}-${row.seq}`, timing } };
        });
      return {
        kind: 'read',
        value: read({
          after: (id, after, count) =>
            progressPage(
              raw(id)
                .filter((row) => row.seq > after)
                .slice(0, count + 1),
              count,
              frontier,
            ),
          before: (id, before, count) =>
            progressTail(
              raw(id)
                .filter((row) => before === null || row.seq < before)
                .reverse()
                .slice(0, count + 1),
              count,
              frontier,
            ),
        }),
      };
    };
  const select = (session: WaitSession, visit: ProgressVisit) =>
    session.withProgress(visit, (sources) => {
      session.position(sources, null, 500, 65536);
      return session.select(sources, 500, 65536);
    });

  it('settles only the job whose row failed to decode and keeps its other-epoch sibling readable', () => {
    const session = new WaitSession(['a1', 'b1']);
    session.reconcile([admitted('a1', [], true, 'epoch-E1'), admitted('b1', [], true, 'epoch-E2')]);
    const selected = select(session, visitRows({ a1: [{ seq: 5 }, 'undecodable'], b1: [{ seq: 7 }, { seq: 8 }] }));
    expect(selected.lines.map((line) => line.text)).toEqual(['b1-7', 'b1-8']);
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
        before: () => progressTail([], 1, 0),
      }),
    });
    expect(() => select(session, defect)).toThrow(TypeError);
  });

  it('holds only the faulted epoch on a transient page failure', () => {
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
              before: () => progressTail([], 1, 0),
            }),
          }
        : testProgressVisit(epoch, read);
    observeWaitRead(() => session.admissions)();
    const selected = select(session, busy);
    expect(selected.lines.map((line) => line.text)).toEqual(['b-3']);
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

  it('advances a job silently past fault-only pages behind its consumed lines, without a message', () => {
    const rows = { a: [{ seq: 5 }, 'fault', 'fault', 'fault'] as Row[] };
    const session = new WaitSession(['a'], {
      jobs: [{ hash: waitJobHash('a'), epoch: waitEpochToken('epoch-E'), seq: 5, lineOffset: 0, flags: 0 }],
    });
    session.reconcile([admitted('a', [], false)]);
    const first = select(session, visitRows(rows, undefined, 53));
    expect(first.lines).toEqual([]);
    expect(first.advances).toEqual([{ jobId: 'a', seq: 53 }]);
    session.advanceSilently(first.advances);
    expect(session.entry('a')).toMatchObject({ seq: 53, lineOffset: 0 });
    const second = select(session, visitRows(rows, undefined, 53));
    expect(second.advances).toEqual([]);
  });

  it('never moves a job silently past a selected line it has not consumed', () => {
    const session = new WaitSession(['a']);
    session.reconcile([admitted('a', [], false)]);
    session.advanceSilently([
      {
        jobId: 'a',
        seq: 90,
        after: { entryAfter: { ...session.entry('a'), seq: 7 } } as never,
      },
    ]);
    expect(session.entry('a').seq).toBe(0);
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

it('serves every epoch a turn so a chatty first epoch cannot starve the next one', () => {
  const chatty = admitted(
    'chatty',
    Array.from({ length: 600 }, (_, index) => [index + 1, `c-${index}`] as [number, string]),
    false,
    'epoch-E1',
  );
  const quiet = admitted('quiet', [[3, 'q-3']], false, 'epoch-E2');
  const session = new WaitSession(['chatty', 'quiet'], {
    jobs: [
      { hash: waitJobHash('chatty'), epoch: waitEpochToken('epoch-E1'), seq: 0, lineOffset: 0, flags: 0 },
      { hash: waitJobHash('quiet'), epoch: waitEpochToken('epoch-E2'), seq: 0, lineOffset: 0, flags: 0 },
    ],
  });
  session.reconcile([chatty, quiet]);
  expect(selectTestProgress(session, 500).map((line) => line.text)).toContain('q-3');
});

it('selects each line once when a deferred member keeps an older alias of the same epoch', () => {
  const s1 = JSON.stringify({ storeRoot: '/a', epoch: '1', path: '/a/epoch-1/store.db', lineageKey: 'L:1' });
  const s2 = JSON.stringify({ storeRoot: '/b', epoch: '1', path: '/b/epoch-1/store.db', lineageKey: 'L:1' });
  const session = new WaitSession(['j1', 'j2']);
  const j1 = admitted('j1', [[1, 'j1 line']], false, s1);
  const j2 = admitted('j2', [[2, 'j2 line']], false, s2);
  session.reconcile([j1, j2]);
  session.reconcile([
    { jobId: 'j1', disposition: 'discovery-unknown', sourceRead: 'transient-unknown', observationDeferred: true },
    j2,
  ]);
  observeWaitRead(() => [j1, j2])();
  expect(selectTestProgress(session).map((line) => line.text)).toEqual(['j1 line', 'j2 line']);
});

it('exhausts a job whose saved line offset lies past its row instead of holding it unread forever', () => {
  const job = admitted('a', [[5, 'one\ntwo']], false);
  const session = new WaitSession(['a'], {
    jobs: [{ hash: waitJobHash('a'), epoch: waitEpochToken('epoch-E'), seq: 5, lineOffset: 9, flags: 0 }],
  });
  session.reconcile([job]);
  expect(selectTestProgress(session)).toEqual([]);
  expect(session.progressState('a')).toBe('exhausted');
  expect(session.hasProgress()).toBe(false);
});

it('never selects from a member whose tail scan is unfinished, since its seq is a scan boundary', () => {
  const timing = { origin: 'runtime' as const, originAt: '', emittedAt: '', elapsedMs: 0 };
  const raw = Array.from({ length: 10 }, (_, index) => ({
    seq: index + 1,
    progress: { seq: index + 1, message: `line-${index + 1}`, timing },
  }));
  const session = new WaitSession(['a'], {
    jobs: [{ hash: waitJobHash('a'), epoch: waitEpochToken('epoch-E'), seq: 6, lineOffset: 5, flags: 12 }],
  });
  session.reconcile([admitted('a', [], false)]);
  const reads: number[] = [];
  const selection = session.withProgress(
    (_epoch, visit) => ({
      kind: 'read',
      value: visit({
        after: (_id, after, count) => {
          reads.push(after);
          return progressPage(raw.filter((row) => row.seq > after).slice(0, count + 1), count, 10);
        },
        before: (_id, before, count) =>
          progressTail(
            raw
              .filter((row) => before === null || row.seq < before)
              .reverse()
              .slice(0, count + 1),
            count,
            10,
          ),
      }),
    }),
    (sources) => session.select(sources, 500, 65536),
  );
  expect(reads).toEqual([]);
  expect(selection).toMatchObject({ lines: [], cut: true });
  expect(session.entry('a')).toMatchObject({ seq: 6, lineOffset: 5, flags: 12 });
});
