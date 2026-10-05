import type { JobLocation, JobLocationView } from '#src/jobs/location-index.js';
import type { WaitStreamEvent, WaitCursorV3 } from '#src/jobs/wait/contract.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { createRealTimePort } from '#src/infra/time.js';
import { admitted } from '#tests/helpers/wait-session.js';
import { describe, expect, it, vi } from 'vitest';
import { WaitSession, type SourceReadDisposition } from '#src/jobs/wait/session.js';
import { waitEpochToken, waitJobHash } from '#src/jobs/wait/cursor.js';
import { selectWaitSnapshot } from '#src/jobs/wait/snapshot.js';

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
    session.consume(session.progress()[0]);
    expect(session.progress().map((line) => line.text)).toEqual(['b2', 'a3', 'b4']);
    session.acknowledge(session.admissions[0]);
    expect(session.remaining()).toEqual(['a', 'b']);
    const resumed = new WaitSession(['b', 'a'], session.cursor());
    resumed.reconcile([...session.admissions].reverse());
    expect(resumed.progress().map((line) => line.text)).toEqual(['b2', 'a3', 'b4']);
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
    expect(session.progress().map((line) => line.text)).toEqual(['one', 'two']);
    session.consume(session.progress()[0]);
    const resumed = new WaitSession(['a'], session.cursor());
    resumed.reconcile([a]);
    expect(resumed.progress().map((line) => line.text)).toEqual(['two']);
    expect(resumed.acknowledged('a')).toBe(true);
    expect(resumed.artifactPending('a')).toBe(true);
    expect(resumed.remaining()).toEqual(['a']);
    resumed.consume(resumed.progress()[0]);
    expect(resumed.remaining()).toEqual(['a']);
    resumed.settleArtifact('a');
    expect(resumed.remaining()).toEqual([]);
  });

  it.each(['snapshot-to-stream', 'stream-to-snapshot'])(
    'resets new or unresolved epoch membership once on %s without losing flags',
    (direction) => {
      const a = admitted('a', [[100, 'a100']]);
      a.availability = { kind: 'repair-pending', ageUncertain: false };
      const session = new WaitSession(['a', 'u']);
      session.reconcile([a, { jobId: 'u', disposition: 'discovery-unknown' }]);
      const cursor =
        direction === 'snapshot-to-stream'
          ? selectWaitSnapshot(session, 20).cursor
          : (() => {
              session.consume(session.progress()[0]);
              session.acknowledge(a);
              return session.cursor();
            })();
      expect(cursor.jobs.find((job) => job.hash === waitJobHash('u'))).toMatchObject({ epoch: 255, flags: 4 });
      const joined = [a, admitted('u', [[2, 'u below 100']], false)];
      const resumed = new WaitSession(['a', 'u'], cursor);
      resumed.reconcile(joined);
      expect(resumed.progress().map((line) => line.text)).toEqual(['u below 100', 'a100']);
      expect(resumed.notices).toEqual([expect.stringContaining('membership changed')]);
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
    expect(session.cursor().epochs[0].token).toBe(waitEpochToken('epoch-E'));
  });
});

it.each([false, true])(
  'retained history cannot supply progress or an unvalidated outcome without a successful source read, corrupt=%s',
  (corrupt) => {
    const h = admitted('h', [[1, 'retained progress']], true, 'old');
    const detail = h.detail!;
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
      { epochKey: () => 'active', detail: () => null } as never,
      () => false,
      () => 'decided',
      () => ({ kind: 'unreadable', disposition: 'retired', retired: true }),
      () => ({ kind: 'retained-away', retentionDays: 14 }),
    );
    const snapshot = reader.snapshot({ jobIds: ['h'], projectRoot: '/tmp' });
    expect(snapshot.jobs[0].progress).toEqual([]);
    if (!corrupt) expect(snapshot.notices).toContain('earlier progress for h is no longer kept');
    if (corrupt) {
      expect(snapshot.jobs[0].terminal).toBeUndefined();
      expect(snapshot.remainingJobIds).toEqual([]);
      expect(snapshot.exitCode).toBe(1);
    } else expect(snapshot.jobs[0].terminal).toBeDefined();
  },
);

it('translates a released acknowledgement into pending artifact collection without replaying its outcome', () => {
  const a = admitted('a');
  a.availability = { kind: 'repair-pending', ageUncertain: false };
  const session = new WaitSession(['a'], {
    version: 'jobs.wait.v2',
    positions: { 'epoch-E': 0 },
    locations: { a: 'epoch-E' },
    deliveredJobIds: ['a'],
  });
  session.reconcile([a]);
  const snapshot = selectWaitSnapshot(session);
  expect(snapshot.jobs[0].terminal).toBeUndefined();
  expect(snapshot.jobs[0].alreadyCollected).toBe(true);
  expect(snapshot.remainingJobIds).toEqual(['a']);
  expect(snapshot.cursor.jobs[0].flags).toBe(3);
});

it('versionless acknowledgements do not invent a membership reset', () => {
  const a = admitted('a', [[100, 'a100']]);
  const u = admitted('u', [[2, 'u2']], false);
  const session = new WaitSession(['a', 'u'], { afterSeq: 100, deliveredJobIds: ['a'] }, 'epoch-E');
  session.reconcile([a, u]);
  expect(session.progress().map((line) => line.text)).toEqual([]);
  expect(session.acknowledged('a')).toBe(true);
  expect(session.notices).toEqual([]);
});

it.each([
  ['a', 'b'],
  ['b', 'a'],
])('internal replacement membership %j preserves the sibling frontier', (...jobIds) => {
  const input = {
    version: 'jobs.wait.v3' as const,
    epochs: [{ token: waitEpochToken('real-epoch'), watermark: 10, lineOffset: 0 }],
    jobs: [{ hash: waitJobHash('a'), epoch: 0, flags: 0 }],
  };
  const session = new WaitSession(jobIds, input, 'real-epoch', true);
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
  expect(session.progress().map((line) => line.text)).toEqual(['new member']);
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
    version: 'jobs.wait.v2' as const,
    locations: Object.fromEntries(jobs.map((job) => [job.jobId, 'epoch-E'])),
    positions: { 'epoch-E': 4999 },
  };
  const session = new WaitSession(
    jobs.map((job) => job.jobId),
    input,
  );
  const split = vi.spyOn(String.prototype, 'split');
  try {
    for (let poll = 0; poll < 20; poll++) {
      session.reconcile(jobs);
      session.progress();
      session.remaining();
      session.cursor();
    }
    expect(split.mock.calls.filter((call) => (call[0] as unknown) === '\n').length).toBe(32);
  } finally {
    split.mockRestore();
  }
});

it('versionless membership evidence never acknowledges a terminal before delivery', () => {
  const job = admitted('a', [[1, 'received progress']]);
  const session = new WaitSession(['a'], { afterSeq: 1, deliveredJobIds: [], admittedJobIds: ['a'] }, 'epoch-E');
  session.reconcile([job]);
  expect(session.progress()).toEqual([]);
  expect(session.acknowledged('a')).toBe(false);
  expect(selectWaitSnapshot(session).jobs[0].terminal).toBeDefined();
});

it('holds the shared progress frontier while one member history is unreadable', () => {
  const a = admitted('a');
  a.sourceRead = 'transient-unknown';
  a.progressUnknown = true;
  const b = admitted('b', [[5, 'sibling backlog']]);
  const session = new WaitSession(['a', 'b']);
  session.reconcile([a, b]);
  const first = selectWaitSnapshot(session, 20);
  expect(first.jobs[1].progress).toEqual([]);
  expect(first.remainingJobIds).toEqual(['a', 'b']);
  expect(first.cursor.epochs[0].watermark).toBe(0);
  const resumed = new WaitSession(['a', 'b'], first.cursor);
  resumed.reconcile([admitted('a', [[3, 'recovered backlog']]), b]);
  const next = selectWaitSnapshot(resumed);
  expect(next.jobs.map((job) => job.progress)).toEqual([['recovered backlog'], ['sibling backlog']]);
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
      expect(session.progress()).toEqual([]);
      expect(session.remaining()).toEqual(['A', 'U']);
      expect(session.notices.some((notice) => notice.includes('A') && notice.includes('is held'))).toBe(true);
      expect(session.cursor(session.remaining()).epochs[0].watermark).toBe(0);
    } else {
      expect(session.progress().map((line) => line.text)).toEqual(['a-ten', 'a-eleven']);
      expect(session.remaining()).toEqual(['A']);
      for (const line of session.progress()) session.consume(line);
      expect(session.remaining()).toEqual([]);
    }
  },
);

it('a versionless deliveredJobIds list acknowledges terminals without declaring membership', () => {
  const session = new WaitSession(['b'], { afterSeq: 50, deliveredJobIds: ['a'] }, 'epoch-E');
  session.reconcile([
    admitted(
      'b',
      [
        [40, 'already seen'],
        [60, 'next'],
      ],
      false,
    ),
  ]);
  expect(session.notices).toEqual([]);
  expect(session.progress().map((line) => line.text)).toEqual(['next']);
});

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
    const cursor: WaitCursorV3 = {
      version: 'jobs.wait.v3',
      epochs: [{ token: waitEpochToken(E), watermark: 4, lineOffset: 0 }],
      jobs: [
        { hash: waitJobHash('a'), epoch: 0, flags: 0 },
        { hash: waitJobHash('b'), epoch: 0, flags: 0 },
      ],
    };
    const events: WaitStreamEvent[] = [];
    // first read() is validateWait's admission (failB=0 -> ok), second is the stream's first poll (failB=1 -> EMFILE)
    for await (const e of addressing.waitStream({
      jobIds: ['a', 'b'],
      supportsWaitV3: true,
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
  expect(session.progress().map((line) => line.text)).toEqual(['a1', 'b2', 'a3']);
  expect(session.cursor().epochs).toHaveLength(1);
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
