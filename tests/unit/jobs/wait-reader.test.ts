import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import { WaitCoordinator } from '#src/jobs/shell/wait.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { waitEpochToken, waitJobHash } from '#src/jobs/wait/cursor.js';
import { describe } from 'vitest';
import { loadReleasedWait } from '#tests/helpers/released-wait.js';
import { rmSync } from 'node:fs';
import { expect, it, vi, afterEach } from 'vitest';

import { readWaitSession } from '#src/jobs/wait/reader.js';
import { WaitSession } from '#src/jobs/wait/session.js';
import type { WaitAdmission } from '#src/jobs/wait/session.js';
import { selectWaitSnapshot, parseWaitSnapshot } from '#src/jobs/wait/snapshot.js';
import { createRealTimePort } from '#src/infra/time.js';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';

import { admitted } from '#tests/helpers/wait-session.js';
import type { WaitStreamEvent, WaitCursor, WaitCursorV3 } from '#src/jobs/wait/contract.js';

import { parseWaitStreamEventValue } from '#src/jobs/wait/stream-event.js';
import { serializeWaitCursor } from '#src/jobs/wait/cursor.js';
import { formatWaitSnapshot, formatWaitWaiting, formatWaitProgress, formatWaitTerminal } from '#src/cli/format/wait.js';

async function collect(stream: AsyncGenerator<WaitStreamEvent>): Promise<WaitStreamEvent[]> {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

it('does not rebuild history for each delivered event cursor', async () => {
  const job = admitted(
    'a',
    Array.from({ length: 2000 }, (_, i) => [i + 1, `cost-probe-${i}`]),
    false,
  );
  const split = vi.spyOn(String.prototype, 'split');
  try {
    const events = await collect(
      readWaitSession({
        request: { jobIds: ['a'], supportsWaitV3: true, timeoutSeconds: 0 },
        time: createRealTimePort(),
        activeEpochKey: 'epoch-E',
        read: () => [job],
      }),
    );
    expect(events.filter((event) => event.type === 'progress')).toHaveLength(20);
    expect(split.mock.calls.length).toBeLessThanOrEqual(100);
  } finally {
    split.mockRestore();
  }
});

it('drains a legacy terminal backlog and closes an acknowledged continuation with empty waiting', async () => {
  const job = admitted(
    'a',
    Array.from({ length: 600 }, (_, i) => [i + 1, `line-${i}`]),
  );
  const read = (cursor?: WaitCursor) =>
    collect(
      readWaitSession({
        request: { jobIds: ['a'], supportsWaitV2: true, timeoutSeconds: 0, cursor },
        time: createRealTimePort(),
        activeEpochKey: 'epoch-E',
        read: () => [job],
      }),
    );
  const first = await read();
  expect(first.filter((event) => event.type === 'progress')).toHaveLength(600);
  expect(first.at(-1)).toMatchObject({ type: 'terminal', remainingJobIds: [] });
  expect(await read(first.find((event) => event.type === 'terminal')!.cursor)).toEqual([
    expect.objectContaining({ type: 'waiting', waitingJobIds: [] }),
  ]);
});

it('keeps completed live coverage when a later refresh outlives the deadline', async () => {
  const time = new VirtualTime();
  let calls = 0;
  const stream = readWaitSession({
    request: { jobIds: ['a'], supportsWaitV3: true, timeoutSeconds: 1 },
    time,
    activeEpochKey: 'epoch-E',
    read: () => [admitted('a', [], false)],
    observe: (session) => {
      if (++calls === 1) session.observeCoverage(['a'], [], 3);
      else return new Promise<void>(() => {});
    },
  });
  const next = stream.next();
  await flushMicrotasks(20);
  for (let i = 0; i < 4; i++) {
    time.tick(250);
    await flushMicrotasks(20);
  }
  expect((await next).value).toMatchObject({ type: 'waiting' });
  expect((await next).value).not.toHaveProperty('carrierUnknownJobIds');
  await stream.return(undefined);
});

it('refuses a legacy membership replay before delivering any member', async () => {
  const events: WaitStreamEvent[] = [];
  await expect(
    (async () => {
      for await (const event of readWaitSession({
        request: {
          jobIds: ['a', 'b'],
          supportsWaitV2: true,
          cursor: {
            version: 'jobs.wait.v2',
            locations: { a: 'epoch-E' },
            positions: { 'epoch-E': 100 },
          },
        },
        time: createRealTimePort(),
        activeEpochKey: 'epoch-E',
        read: () => [admitted('a', [], false), admitted('b', [[10, 'unread b']])],
      }))
        events.push(event);
    })(),
  ).rejects.toMatchObject({ code: 'wait_cursor_epoch_required', message: expect.stringContaining('without') });
  expect(events).toEqual([]);
});

it('refuses a legacy partially missing batch before delivering its successful sibling', async () => {
  const stream = readWaitSession({
    request: { jobIds: ['a', 'ghost'], supportsWaitV2: true, timeoutSeconds: 0 },
    time: createRealTimePort(),
    activeEpochKey: 'epoch-E',
    read: () => [admitted('a'), { jobId: 'ghost', disposition: 'missing' }],
  });
  await expect(stream.next()).rejects.toMatchObject({
    code: 'jobs_not_found',
    message: expect.stringContaining('ghost'),
  });
});

it('refuses a missing legacy member discovered during streaming', async () => {
  const time = new VirtualTime();
  let missing = false;
  const stream = readWaitSession({
    request: { jobIds: ['a'], supportsWaitV2: true, timeoutSeconds: 1 },
    time,
    activeEpochKey: 'epoch-E',
    read: () => (missing ? [{ jobId: 'a', disposition: 'missing' }] : [admitted('a', [], false)]),
  });
  const next = stream.next();
  const assertion = expect(next).rejects.toMatchObject({ code: 'jobs_not_found' });
  await flushMicrotasks(20);
  missing = true;
  time.tick(250);
  await flushMicrotasks(20);
  await assertion;
});

it('refreshes carrier coverage from live to unknown within the original deadline', async () => {
  const time = new VirtualTime();
  let calls = 0;
  const stream = readWaitSession({
    request: { jobIds: ['a'], supportsWaitV3: true, timeoutSeconds: 1 },
    time,
    activeEpochKey: 'epoch-E',
    read: () => [admitted('a', [], false)],
    observe: (session) => {
      session.observeCoverage(['a'], ++calls === 1 ? [] : ['a'], 0);
    },
  });
  const next = stream.next();
  await flushMicrotasks(20);
  for (let i = 0; i < 4; i++) {
    time.tick(250);
    await flushMicrotasks(20);
  }
  expect((await next).value).toMatchObject({ type: 'waiting', carrierUnknownJobIds: ['a'] });
  expect(calls).toBeGreaterThan(1);
  await stream.return(undefined);
});

it('keeps one cancellable carrier observation in flight and ignores its late reply', async () => {
  const time = new VirtualTime();
  let calls = 0;
  let observedSignal: AbortSignal | undefined;
  let complete!: () => void;
  const stream = readWaitSession({
    request: { jobIds: ['a'], supportsWaitV3: true, timeoutSeconds: 1 },
    time,
    activeEpochKey: 'epoch-E',
    read: () => [admitted('a', [], false)],
    observe: async (session, signal) => {
      calls++;
      observedSignal = signal;
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      if (!signal.aborted) session.observeCoverage(['a'], [], 0);
    },
  });
  const next = stream.next();
  await flushMicrotasks(20);
  for (let i = 0; i < 4; i++) {
    time.tick(250);
    await flushMicrotasks(20);
  }
  expect((await next).value).toMatchObject({ type: 'waiting', carrierUnknownJobIds: ['a'] });
  await stream.return(undefined);
  expect(calls).toBe(1);
  expect(observedSignal?.aborted).toBe(true);
  complete();
  await flushMicrotasks(20);
  expect(calls).toBe(1);
});

it.each(['snapshot-to-stream', 'stream-to-snapshot'])(
  'exchanges real %s readers when unresolved U joins below A frontier',
  async (direction) => {
    const a = admitted('a', [[100, 'a100']]);
    a.availability = { kind: 'repair-pending', ageUncertain: false };
    const unresolved: WaitAdmission[] = [a, { jobId: 'u', disposition: 'discovery-unknown' }];
    let cursor: WaitCursorV3;
    if (direction === 'snapshot-to-stream') {
      const session = new WaitSession(['a', 'u']);
      session.reconcile(unresolved);
      cursor = selectWaitSnapshot(session, 20).cursor;
    } else {
      const events = await collect(
        readWaitSession({
          request: { jobIds: ['a', 'u'], supportsWaitV3: true },
          time: createRealTimePort(),
          activeEpochKey: 'epoch-E',
          read: () => unresolved,
        }),
      );
      cursor = events.find((event) => event.type === 'terminal')!.cursor as WaitCursorV3;
    }
    const joined = [a, admitted('u', [[2, 'u below 100']], false)];
    if (direction === 'snapshot-to-stream') {
      const events = await collect(
        readWaitSession({
          request: { jobIds: ['a', 'u'], supportsWaitV3: true, cursor, timeoutSeconds: 0 },
          time: createRealTimePort(),
          activeEpochKey: 'epoch-E',
          read: () => joined,
        }),
      );
      expect(events.filter((event) => event.type === 'progress').map((event) => event.message)).toEqual([
        'u below 100',
        'a100',
      ]);
      expect(events.filter((event) => event.type === 'terminal')).toEqual([]);
      expect(events.find((event) => event.type === 'notice')).toMatchObject({
        message: expect.stringContaining('membership changed'),
      });
      cursor = events.at(-1)!.cursor as WaitCursorV3;
    } else {
      const session = new WaitSession(['a', 'u'], cursor);
      session.reconcile(joined);
      const snapshot = selectWaitSnapshot(session);
      expect(snapshot.jobs[1].progress).toEqual(['u below 100']);
      expect(snapshot.jobs[0].alreadyCollected).toBe(true);
      expect(snapshot.jobs[0].terminal).toBeUndefined();
      expect(snapshot.notices).toEqual(expect.arrayContaining([expect.stringContaining('membership changed')]));
      cursor = snapshot.cursor;
    }
    expect(cursor.jobs.some((job) => job.flags === 3)).toBe(true);
  },
);

it('delivers a second terminal after an acknowledged sibling and returns the set failure code while draining progress', async () => {
  const a = admitted('a', [[1, 'older']], true, 'epoch-E', true);
  const b = admitted('b', [[2, 'other']]);
  const session = new WaitSession(['a', 'b']);
  session.reconcile([a, b]);
  session.acknowledge(a);
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['a', 'b'], cursor: session.cursor(), supportsWaitV3: true },
      time: createRealTimePort(),
      activeEpochKey: 'epoch-E',
      read: () => [a, b],
    }),
  );
  expect(events.filter((event) => event.type === 'terminal')).toEqual([
    expect.objectContaining({ jobId: 'b', exitCode: 42 }),
  ]);
  expect(events.filter((event) => event.type === 'progress')).toHaveLength(2);
});

it.each(['delayed', 'throws'])(
  'timeout reads unknown session coverage with a %s observer, and unknown never finalizes a job',
  async (observer) => {
    const time = new VirtualTime();
    const a = admitted('a', [], false);
    const stream = readWaitSession({
      request: { jobIds: ['a'], timeoutSeconds: 1, supportsWaitV3: true },
      time,
      activeEpochKey: 'epoch-E',
      read: () => [a],
      observe: () => {
        if (observer === 'throws') throw new Error('observer failed');
      },
    });
    const next = stream.next();
    await flushMicrotasks(20);
    for (let i = 0; i < 4; i++) {
      time.tick(250);
      await flushMicrotasks(20);
    }
    await expect(next).resolves.toMatchObject({
      value: { type: 'waiting', carrierUnknownJobIds: ['a'], waitingJobIds: ['a'], exitCode: 75 },
    });
    await stream.return(undefined);
  },
);

it('returns artifact settlement without replaying the terminal and re-evaluates mid-wait dispositions', async () => {
  const a = admitted('a');
  a.availability = { kind: 'repair-pending', ageUncertain: false };
  const session = new WaitSession(['a']);
  session.reconcile([a]);
  session.acknowledge(a);
  a.availability = { kind: 'available', resultPath: '/settled/a' };
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['a'], cursor: session.cursor(), supportsWaitV3: true },
      time: createRealTimePort(),
      activeEpochKey: 'epoch-E',
      read: () => [a],
    }),
  );
  expect(events).toEqual([
    expect.objectContaining({
      type: 'artifact',
      availability: { kind: 'available', resultPath: '/settled/a' },
      exitCode: 0,
      remainingJobIds: [],
    }),
  ]);
  const time = new VirtualTime();
  let closure = false;
  const stream = readWaitSession({
    request: { jobIds: ['u'], supportsWaitV3: true, timeoutSeconds: 1 },
    time,
    activeEpochKey: 'epoch-E',
    read: () =>
      closure ? [{ jobId: 'u', disposition: 'outcome-unrecoverable' }] : [admitted('u', [], false, 'old-epoch')],
  });
  const next = stream.next();
  await flushMicrotasks(20);
  closure = true;
  time.tick(250);
  await flushMicrotasks(20);
  await expect(next).resolves.toMatchObject({ value: { type: 'disposition', disposition: 'outcome-unrecoverable' } });
  await expect(stream.next()).resolves.toMatchObject({
    value: { type: 'notice', message: 'Wait complete; no jobs remain.', exitCode: 1 },
  });
  await stream.return(undefined);
});

it('resets membership resolved during a bounded wait and preserves acknowledged artifact state', async () => {
  const a = admitted('a', [[100, 'a100']]);
  a.availability = { kind: 'repair-pending', ageUncertain: false };
  const previous = new WaitSession(['a', 'u']);
  previous.reconcile([a, { jobId: 'u', disposition: 'discovery-unknown' }]);
  const saved = selectWaitSnapshot(previous, 20).cursor;
  const time = new VirtualTime();
  let resolved = false;
  const stream = readWaitSession({
    request: { jobIds: ['a', 'u'], supportsWaitV3: true, timeoutSeconds: 1, cursor: saved },
    time,
    activeEpochKey: 'epoch-E',
    read: () => [a, resolved ? admitted('u', [[2, 'u2']], false) : { jobId: 'u', disposition: 'discovery-unknown' }],
  });
  expect((await stream.next()).value).toMatchObject({ type: 'disposition', disposition: 'discovery-unknown' });
  const next = stream.next();
  await flushMicrotasks(20);
  resolved = true;
  time.tick(250);
  await flushMicrotasks(20);
  expect((await next).value).toMatchObject({ type: 'notice', message: expect.stringContaining('membership changed') });
  expect((await stream.next()).value).toMatchObject({ type: 'progress', jobId: 'u', message: 'u2' });
  expect((await stream.next()).value).toMatchObject({
    type: 'progress',
    jobId: 'a',
    message: 'a100',
    cursor: { jobs: [expect.objectContaining({ flags: 3 }), expect.objectContaining({ flags: 0 })] },
  });
  await stream.return(undefined);
});
{
  afterEach(() => vi.restoreAllMocks());
  it('formats an empty waiting set as settled without a cursor', () => {
    expect(formatWaitWaiting({ type: 'waiting', waitingJobIds: [] }, 'input-cursor', [])).toBe(
      'Wait complete; no jobs remain.',
    );
  });
  it('omits a cursor after an embedded terminal settles the collection', () => {
    const text = formatWaitTerminal(
      {
        type: 'terminal',
        jobId: 'a',
        seq: 1,
        result: { content: 'done', outcome: { kind: 'completed' }, durationMs: 1 },
        remainingJobIds: [],
      },
      'input-cursor',
      true,
    );
    expect(text).toContain('No remaining jobs.');
    expect(text).not.toContain('Cursor:');
  });
  it('retains settled carrier coverage at a page boundary while a refresh is pending (page-carrier probe)', async () => {
    let reads = 0;
    let observations = 0;
    const job = admitted('live-job', [], false);
    const backlog = admitted(
      'live-job',
      Array.from({ length: 600 }, (_, index) => [index + 1, `line ${index}`]),
      false,
    );
    const stream = readWaitSession({
      request: { jobIds: ['live-job'], supportsWaitV3: true, timeoutSeconds: 590 },
      time: createRealTimePort(),
      activeEpochKey: 'epoch-E',
      read: () => (++reads === 1 ? [job] : [backlog]),
      observe: async (session, signal) => {
        observations++;
        if (observations === 1) session.observeCoverage(['live-job'], [], 601);
        else await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    });
    let waiting;
    for await (const event of stream) if (event.type === 'waiting') waiting = event;
    expect(observations).toBe(1);
    expect(waiting).toMatchObject({ waitingJobIds: ['live-job'] });
    expect(waiting?.carrierUnknownJobIds).toBeUndefined();
  });
  it('downgrades coverage after a failed refresh', async () => {
    const time = new VirtualTime();
    const job = admitted('live-job', [], false);
    let observations = 0;
    const stream = readWaitSession({
      request: { jobIds: ['live-job'], supportsWaitV3: true, timeoutSeconds: 0.3 },
      time,
      activeEpochKey: 'epoch-E',
      read: () => [job],
      observe: (session) => {
        if (++observations === 1) session.observeCoverage(['live-job'], [], 10);
        else throw new Error('unobservable');
      },
    });
    const result = collect(stream);
    await flushMicrotasks(20);
    time.tick(250);
    await flushMicrotasks(20);
    time.tick(50);
    const events = await result;
    expect(events.at(-1)).toMatchObject({ type: 'waiting', carrierUnknownJobIds: ['live-job'] });
  });
  it('preserves input acknowledgement and artifact flags after an initial non-admission', () => {
    const job = admitted('a');
    job.availability = { kind: 'repair-pending', ageUncertain: false };
    const first = new WaitSession(['a']);
    first.reconcile([job]);
    first.acknowledge(job);
    const resumed = new WaitSession(['a'], first.cursor());
    resumed.reconcile([{ jobId: 'a', disposition: 'discovery-unknown' }]);
    resumed.reconcile([job]);
    expect(resumed.acknowledged('a')).toBe(true);
    expect(resumed.artifactPending('a')).toBe(true);
  });
  it('does not report an undelivered sibling failure in a terminal event', async () => {
    const jobs = [admitted('a'), admitted('b', [], true, 'epoch-E', true)];
    const stream = readWaitSession({
      request: { jobIds: ['a', 'b'], supportsWaitV3: true },
      time: createRealTimePort(),
      activeEpochKey: 'epoch-E',
      read: () => jobs,
    });
    expect((await stream.next()).value).toMatchObject({
      type: 'terminal',
      jobId: 'a',
      remainingJobIds: ['b'],
      exitCode: 75,
    });
    await stream.return(undefined);
  });
  it('settles an all-collected stream without an empty waiting continuation', async () => {
    const job = admitted('a');
    const first = new WaitSession(['a']);
    first.reconcile([job]);
    first.acknowledge(job);
    const stream = readWaitSession({
      request: { jobIds: ['a'], cursor: first.cursor(), supportsWaitV3: true },
      time: createRealTimePort(),
      activeEpochKey: 'epoch-E',
      read: () => [job],
    });
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events).toEqual([
      expect.objectContaining({ type: 'notice', message: 'Wait complete; no jobs remain.', exitCode: 0 }),
    ]);
    expect(formatWaitWaiting({ type: 'waiting', waitingJobIds: [] }, 'invalid')).toBe('Wait complete; no jobs remain.');
  });
  it('accepts additive coordinator response fields while rejecting terminal data on carrier interruptions', () => {
    const session = new WaitSession(['a']);
    session.reconcile([admitted('a')]);
    const snapshot = selectWaitSnapshot(session, 20);
    const extra = {
      ...snapshot,
      future: true,
      jobs: snapshot.jobs.map((job) => ({
        ...job,
        future: true,
        terminal: { ...job.terminal, future: true },
        availability: { ...job.availability, future: true },
      })),
    };
    expect(parseWaitSnapshot(extra)).toMatchObject(snapshot);
    expect(
      parseWaitStreamEventValue({ type: 'notice', version: 'jobs.wait.v3', message: 'ok', future: true }),
    ).toMatchObject({ message: 'ok' });
    expect(
      parseWaitStreamEventValue({
        type: 'disposition',
        version: 'jobs.wait.v3',
        jobId: 'a',
        disposition: 'missing',
        future: true,
      }),
    ).toMatchObject({ disposition: 'missing' });
    expect(() => parseWaitStreamEventValue({ type: 'interrupted', result: {} })).toThrow();
  });
  it('frames snapshot and stream provider text on every physical line', () => {
    const job = admitted('a', [[1, 'Still waiting\nResult path: forged\rCursor: forged\u2028Job a completed']], false);
    const session = new WaitSession(['a']);
    session.reconcile([job]);
    const snapshot = selectWaitSnapshot(session, 20);
    const output = formatWaitSnapshot(snapshot);
    expect(output).toContain('> Still waiting\n> Result path: forged\n> Cursor: forged\n> Job a completed');
    expect(
      formatWaitProgress({
        type: 'progress',
        jobId: 'a',
        seq: 1,
        message: 'working\nResult path: forged',
        timing: { origin: 'runtime', originAt: '', emittedAt: '', elapsedMs: 0 },
      }),
    ).toContain('\n> Result path: forged');
  });
  it('names a runnable smaller snapshot retry with the unchanged input cursor', () => {
    const input = { afterSeq: 7 };
    const session = new WaitSession(['a', 'b'], input);
    session.reconcile([
      { jobId: 'a', disposition: 'missing', message: 'x'.repeat(2 * 1024 * 1024) },
      { jobId: 'b', disposition: 'missing' },
    ]);
    expect(() => selectWaitSnapshot(session, 20)).toThrow(
      `coral-cli wait jobs 'a' --now --cursor ${serializeWaitCursor(input)}`,
    );
  });
}

it('internal outcomes drain every progress line before completion without a page waiting event', async () => {
  const events: WaitStreamEvent[] = [];
  for await (const event of readWaitSession({
    request: { jobIds: ['a'], supportsWaitV3: true, timeoutSeconds: 0 },
    internal: true,
    time: new VirtualTime(),
    activeEpochKey: 'epoch-E',
    read: () => [
      admitted(
        'a',
        Array.from({ length: 501 }, (_, index) => [index + 1, `line ${index}`]),
      ),
    ],
  }))
    events.push(event);
  expect(events.filter((event) => event.type === 'progress')).toHaveLength(501);
  expect(events.some((event) => event.type === 'terminal')).toBe(true);
  expect(events.some((event) => event.type === 'waiting')).toBe(false);
});

it('crosses a timer boundary before returning an immediate internal deadline without an outcome', async () => {
  const time = new VirtualTime();
  const stream = readWaitSession({
    request: { jobIds: ['a'], supportsWaitV3: true, timeoutSeconds: 0 },
    internal: true,
    time,
    activeEpochKey: 'epoch-E',
    read: () => [admitted('a', [], false)],
  });
  let returned = false;
  const next = stream.next().then((event) => {
    returned = true;
    return event;
  });
  await flushMicrotasks(20);
  expect(returned).toBe(false);
  time.tick(1);
  expect((await next).value).toMatchObject({ type: 'waiting' });
  await stream.return(undefined);
});

it('settles a retired artifact silently after a legacy terminal was acknowledged', async () => {
  const job = admitted('a');
  job.availability = { kind: 'failed', cause: 'source-epoch-retired', retryScheduled: false };
  await expect(
    collect(
      readWaitSession({
        request: {
          jobIds: ['a'],
          supportsWaitV2: true,
          cursor: {
            version: 'jobs.wait.v2',
            locations: { a: 'epoch-E' },
            positions: { 'epoch-E': 0 },
            deliveredJobIds: ['a'],
          },
          timeoutSeconds: 0,
        },
        time: createRealTimePort(),
        activeEpochKey: 'epoch-E',
        read: () => [job],
      }),
    ),
  ).resolves.toEqual([expect.objectContaining({ type: 'waiting', waitingJobIds: [] })]);
});

it('retries an unknown historical read on a bounded schedule, then exits 75 unresolved', async () => {
  const a = admitted('a', [], false);
  a.sourceRead = 'transient-unknown';
  a.progressUnknown = true;
  let monotonic = 0n;
  const sleep = vi.fn(async (ms: number) => {
    monotonic += BigInt(ms);
  });
  const read = vi.fn(() => [a]);
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['a'], supportsWaitV3: true, timeoutSeconds: 590 },
      time: { ...createRealTimePort(), monotonicNow: () => monotonic, sleep },
      activeEpochKey: 'epoch-E',
      read,
    }),
  );
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 1000, 5000]);
  expect(read).toHaveBeenCalledTimes(4);
  expect(events.at(-1)).toMatchObject({ type: 'waiting', exitCode: 75, waitingJobIds: ['a'] });
  expect(events.find((event) => event.type === 'notice')).toMatchObject({
    message: expect.stringContaining('exit 75'),
  });
});

it('keeps a multiline child message in one internal progress event', async () => {
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['a'], supportsWaitV3: true, timeoutSeconds: 0 },
      time: createRealTimePort(),
      activeEpochKey: 'epoch-E',
      internal: true,
      read: () => [admitted('a', [[1, 'first\nsecond\nthird']])],
    }),
  );
  expect(events.filter((event) => event.type === 'progress')).toMatchObject([
    { seq: 1, message: 'first\nsecond\nthird' },
  ]);
  expect(events.filter((event) => event.type === 'progress')).toHaveLength(1);
});

it('preserves a terminal sibling backlog across a transient epoch hold in stream and snapshot', async () => {
  const a = admitted(
    'A',
    [
      [10, 'A progress 10'],
      [11, 'A progress 11'],
    ],
    true,
    'epoch-H',
  );
  const u = {
    ...admitted('U', [], false, 'epoch-H'),
    detail: undefined,
    sourceRead: 'transient-unknown' as const,
    progressUnknown: true,
  };
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['A', 'U'], supportsWaitV3: true, timeoutSeconds: 0 },
      time: createRealTimePort(),
      activeEpochKey: 'epoch-NEW',
      read: () => [a, u],
    }),
  );
  expect(events.find((event) => event.type === 'terminal')).toMatchObject({ remainingJobIds: ['A', 'U'] });
  expect(
    events.some((event) => event.type === 'notice' && event.message.includes('A') && event.message.includes('is held')),
  ).toBe(true);
  const session = new WaitSession(['A', 'U']);
  session.reconcile([a, u]);
  const snapshot = selectWaitSnapshot(session, 20);
  expect(snapshot.remainingJobIds).toEqual(['A', 'U']);
  expect(snapshot.notices.some((notice) => notice.includes('A') && notice.includes('is held'))).toBe(true);
});

it('does not shorten a live sibling window after transient source retries', async () => {
  let mono = 0n;
  const live = admitted('LIVE', [], false, 'epoch-A');
  const unknown: WaitAdmission = {
    jobId: 'X',
    disposition: 'admitted',
    epochKey: 'epoch-H',
    sourceRead: 'transient-unknown',
    progressUnknown: true,
  };
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['LIVE', 'X'], supportsWaitV3: true, timeoutSeconds: 589 },
      time: {
        ...createRealTimePort(),
        monotonicNow: () => mono,
        sleep: async (ms) => {
          mono += BigInt(ms);
        },
      },
      activeEpochKey: 'epoch-A',
      read: () => [live, unknown],
      observe: (session) => session.observeCoverage(['LIVE'], [], 1),
    }),
  );
  expect(mono).toBe(589000n);
  expect(events.at(-1)).toMatchObject({ type: 'waiting', waitingJobIds: ['LIVE', 'X'] });
});

it('does not let a versionless terminal overtake a repair-pending terminal or skip sibling progress', async () => {
  let mono = 0n;
  const time = {
    ...createRealTimePort(),
    monotonicNow: () => mono,
    sleep: async (ms: number) => {
      mono += BigInt(ms);
    },
  };
  const r = admitted('R');
  const s = admitted('S');
  for (const [job, seq] of [
    [r, 40],
    [s, 60],
  ] as const) {
    job.detail!.events = job.detail!.events.map((event) => (event.type === 'terminal' ? { ...event, seq } : event));
    job.detail!.status.lastSeq = seq;
  }
  r.availability = { kind: 'repair-pending', ageUncertain: false };
  const t = admitted(
    'T',
    [
      [50, 'T fifty'],
      [70, 'T seventy'],
    ],
    false,
  );
  await expect(
    collect(
      readWaitSession({
        request: { jobIds: ['R', 'S', 'T'], timeoutSeconds: 1 },
        time,
        activeEpochKey: 'epoch-E',
        read: () => [r, s, t],
      }),
    ),
  ).resolves.toEqual([expect.objectContaining({ type: 'waiting', waitingJobIds: ['R', 'S', 'T'] })]);
  r.availability = { kind: 'available', resultPath: '/r' };
  const second = await collect(
    readWaitSession({
      request: { jobIds: ['R', 'S', 'T'], timeoutSeconds: 1, cursor: { afterSeq: 0 } },
      time,
      activeEpochKey: 'epoch-E',
      read: () => [r, s, t],
    }),
  );
  expect(second.find((event) => event.type === 'terminal')).toMatchObject({ jobId: 'R', seq: 40 });
  const third = await collect(
    readWaitSession({
      request: { jobIds: ['S', 'T'], timeoutSeconds: 1, cursor: { afterSeq: 40 } },
      time,
      activeEpochKey: 'epoch-E',
      read: () => [s, t],
    }),
  );
  expect(third.find((event) => event.type === 'progress')).toMatchObject({ jobId: 'T', seq: 50 });
});

it('settles a permanently unreadable retained outcome after delivery instead of keeping it in every continuation', async () => {
  const job = {
    ...admitted('h', [], true, 'epoch-OLD'),
    sourceRead: 'settled-unreadable' as const,
    progressUnknown: true,
  };
  const first = await collect(
    readWaitSession({
      request: { jobIds: ['h'], supportsWaitV3: true, timeoutSeconds: 0 },
      time: createRealTimePort(),
      activeEpochKey: 'new',
      read: () => [job],
    }),
  );
  expect(first.find((event) => event.type === 'terminal')).toMatchObject({ exitCode: 0, remainingJobIds: [] });
  const session = new WaitSession(['h']);
  session.reconcile([job]);
  const snapshot = selectWaitSnapshot(session);
  expect(snapshot).toMatchObject({ exitCode: 0, remainingJobIds: [] });
  expect(snapshot.notices.join(' ')).toContain('cannot be read by this build');
  expect(snapshot.notices.join(' ')).not.toContain('no longer kept');
});

const releasedDirectories: string[] = [];
afterEach(() => {
  for (const directory of releasedDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
it.each(['v0.10.15', 'v0.10.17'] as const)('delivers a 600-line backlog through the real %s reader', async (tag) => {
  const released = await loadReleasedWait(tag, releasedDirectories);
  const job = admitted(
    'a',
    Array.from({ length: 600 }, (_, i) => [i + 1, `line-${i}`]),
  );
  const request = {
    jobIds: ['a'],
    projectRoot: '/tmp',
    timeoutSeconds: 1,
    supportsInterrupted: true,
    ...(tag === 'v0.10.17' ? { supportsWaitV2: true, supportsHandover: true } : {}),
  };
  released.jobWaitSchema.parse(request);
  let cursor: WaitCursor = { afterSeq: 0 };
  let lines = 0;
  for await (const wire of readWaitSession({
    request,
    time: createRealTimePort(),
    activeEpochKey: 'epoch-E',
    read: () => [job],
  })) {
    const event = released.parseWaitStreamEventValue(wire);
    cursor = released.advanceWaitRenderCursor(cursor, event).cursor;
    if (event.type === 'progress') lines += event.message.split('\n').length;
    if (event.type === 'terminal') {
      expect(lines).toBe(600);
      expect(event.remainingJobIds).toEqual([]);
      expect(released.formatWaitTerminal(event, null, false)).not.toContain('Run coral-cli wait');
    }
    if (event.type === 'waiting') expect(event.waitingJobIds.length).toBeGreaterThan(0);
  }
  expect(lines).toBe(600);
  if (tag === 'v0.10.17' && cursor.version !== 'jobs.wait.v3') expect(cursor.deliveredJobIds).toContain('a');
});

it('waits resumably for a v0.10.15 pending artifact without returning later sibling progress', async () => {
  const a = admitted('a', [], true);
  a.availability = { kind: 'repair-pending', ageUncertain: false };
  const b = admitted('b', [[2000, 'b later line']], false);
  await expect(
    collect(
      readWaitSession({
        request: { jobIds: ['a', 'b'], timeoutSeconds: 0 },
        time: createRealTimePort(),
        activeEpochKey: 'epoch-E',
        read: () => [a, b],
      }),
    ),
  ).resolves.toEqual([expect.objectContaining({ type: 'waiting', waitingJobIds: ['a', 'b'] })]);
});

it('a settled source ends a wait on the first poll without a continuation', async () => {
  const read = vi.fn((): WaitAdmission[] => [
    { jobId: 'U', disposition: 'outcome-unreadable', sourceRead: 'settled-unreadable' },
  ]);
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['U'], supportsWaitV3: true },
      time: createRealTimePort(),
      activeEpochKey: 'active',
      read,
    }),
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(events.at(-1)).toMatchObject({ type: 'notice', exitCode: 1, cursor: { jobs: [] } });
});

it('rate limits idle carrier observation across forty polls', async () => {
  const time = new VirtualTime();
  const observe = vi.fn((session: WaitSession) => session.observeCoverage(['a'], [], 0));
  const stream = readWaitSession({
    request: { jobIds: ['a'], supportsWaitV3: true, timeoutSeconds: 10 },
    time,
    activeEpochKey: 'epoch-E',
    read: () => [admitted('a', [], false)],
    observe,
  });
  const next = stream.next();
  await flushMicrotasks(20);
  for (let i = 0; i < 40; i++) {
    time.tick(250);
    await flushMicrotasks(20);
  }
  expect((await next).value).toMatchObject({ type: 'waiting' });
  expect(observe).toHaveBeenCalledTimes(3);
  await stream.return(undefined);
});

it('admitted, unknown, admitted retains one acknowledged terminal in a resumed stream', async () => {
  const a = admitted('a');
  const first = new WaitSession(['a']);
  first.reconcile([a]);
  first.acknowledge(a);
  const middle = new WaitSession(['a'], first.cursor());
  middle.reconcile([{ jobId: 'a', disposition: 'discovery-unknown' }]);
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['a'], supportsWaitV3: true, cursor: middle.cursor(), timeoutSeconds: 0 },
      time: createRealTimePort(),
      activeEpochKey: 'epoch-E',
      read: () => [a],
    }),
  );
  expect(events.filter((event) => event.type === 'terminal')).toEqual([]);
  expect(events.at(-1)).toMatchObject({ type: 'notice', exitCode: 0 });
});

it('a fresh bounded poll selects every job tail across a shared epoch without intervening backlog', async () => {
  const jobs = [
    admitted(
      'a',
      Array.from({ length: 2000 }, (_, i) => [i + 1, `a${i}`]),
      false,
    ),
    admitted(
      'b',
      Array.from({ length: 2000 }, (_, i) => [2001 + i, `b${i}`]),
      false,
    ),
  ];
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['a', 'b'], supportsWaitV3: true, timeoutSeconds: 0 },
      time: createRealTimePort(),
      activeEpochKey: 'epoch-E',
      read: () => jobs,
    }),
  );
  const progress = events.filter((event) => event.type === 'progress');
  expect(progress.map((event) => event.message)).toEqual([
    ...Array.from({ length: 20 }, (_, i) => `a${1980 + i}`),
    ...Array.from({ length: 20 }, (_, i) => `b${1980 + i}`),
  ]);
});

describe('discovery retry preserves interleaved progress', () => {
  async function collect(stream: AsyncGenerator<WaitStreamEvent>) {
    const out: WaitStreamEvent[] = [];
    for await (const e of stream) out.push(e);
    return out;
  }

  it('preserves unread progress after one transient member read failure', async () => {
    const cursor: WaitCursorV3 = {
      version: 'jobs.wait.v3',
      epochs: [{ token: waitEpochToken('epoch-E'), watermark: 4, lineOffset: 0 }],
      jobs: [
        { hash: waitJobHash('a'), epoch: 0, flags: 0 },
        { hash: waitJobHash('b'), epoch: 0, flags: 0 },
      ],
    };
    let poll = 0;
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
    const bUnknown: WaitAdmission = {
      jobId: 'b',
      disposition: 'discovery-unknown',
      sourceRead: 'transient-unknown',
      message: 'EMFILE',
    };
    const events = await collect(
      readWaitSession({
        request: { jobIds: ['a', 'b'], supportsWaitV3: true, timeoutSeconds: 2, cursor },
        time: advancingTime(),
        activeEpochKey: 'epoch-E',
        read: () => (++poll === 1 ? [a, bUnknown] : [a, b]),
      }),
    );
    const progress = events.filter((e) => e.type === 'progress').map((e) => e.message);

    expect(progress).toContain('b-5');
  });
});

describe('unknown first member preserves continuation', () => {
  async function collect(stream: AsyncGenerator<WaitStreamEvent>) {
    const out: WaitStreamEvent[] = [];
    for await (const e of stream) out.push(e);
    return out;
  }

  it('uses live epoch positions when the first member is transiently unknown', async () => {
    const cursor: WaitCursorV3 = {
      version: 'jobs.wait.v3',
      epochs: [{ token: waitEpochToken('epoch-E'), watermark: 4, lineOffset: 0 }],
      jobs: [
        { hash: waitJobHash('u'), epoch: 0, flags: 0 },
        { hash: waitJobHash('a'), epoch: 0, flags: 0 },
      ],
    };
    const a = admitted(
      'a',
      [
        [5, 'a-5'],
        [6, 'a-6'],
      ],
      false,
    );
    const u: WaitAdmission = {
      jobId: 'u',
      disposition: 'discovery-unknown',
      sourceRead: 'transient-unknown',
      message: 'EIO',
    } as never;
    const run = async (c: WaitCursorV3) =>
      collect(
        readWaitSession({
          request: { jobIds: ['u', 'a'], supportsWaitV3: true, timeoutSeconds: 1, cursor: c },
          time: advancingTime(),
          activeEpochKey: 'epoch-E',
          read: () => [u, a],
        }),
      );
    const first = await run(cursor);
    expect(first.filter((e) => e.type === 'progress')).toEqual([]);
    const last = first.at(-1) as Extract<WaitStreamEvent, { type: 'waiting' }>;

    if (last.cursor?.version !== 'jobs.wait.v3') throw new Error('missing v3 continuation');
    const second = await run(last.cursor);
    const progress2 = second.filter((e) => e.type === 'progress').map((e) => e.message);

    expect(progress2).toEqual([]);
    const secondLast = second.at(-1) as Extract<WaitStreamEvent, { type: 'waiting' }>;
    const recovered = await collect(
      readWaitSession({
        request: { jobIds: ['u', 'a'], supportsWaitV3: true, timeoutSeconds: 0, cursor: secondLast.cursor },
        time: advancingTime(),
        activeEpochKey: 'epoch-E',
        read: () => [admitted('u', [], false), a],
      }),
    );
    expect(recovered.filter((e) => e.type === 'progress').map((e) => e.message)).toEqual(['a-5', 'a-6']);
  });
});

describe('bounded tail selection excludes older history', () => {
  async function collect(cursor: WaitCursorV3 | undefined, read: () => ReturnType<typeof admitted>[]) {
    let t = 0;
    const time = {
      monotonicNow: () => BigInt(t),
      now: () => t,
      sleep: async (ms: number) => {
        t += Math.max(ms, 1);
      },
    } as never;
    const events: WaitStreamEvent[] = [];
    for await (const event of readWaitSession({
      request: { jobIds: ['A', 'B'], supportsWaitV3: true, timeoutSeconds: 1, ...(cursor ? { cursor } : {}) },
      time,
      activeEpochKey: 'epoch-E',
      read,
    }))
      events.push(event);
    return events;
  }

  describe('first bounded v3 tail selection', () => {
    it('does not replay history that the tail intentionally excluded', async () => {
      // A: 30 long lines at seq 1..30 (4000 bytes each). B: 100 short lines at seq 31..130. Both running.
      const a = admitted(
        'A',
        Array.from({ length: 30 }, (_, i) => [i + 1, `A${i + 1} ${'x'.repeat(3990)}`] as [number, string]),
        false,
      );
      const b = admitted(
        'B',
        Array.from({ length: 100 }, (_, i) => [i + 31, `B${i + 31}`] as [number, string]),
        false,
      );
      const read = () => [a, b];
      const first = await collect(undefined, read);
      expect(first.filter((e) => e.type === 'progress').length).toBeGreaterThan(0);
      const last = [...first].reverse().find((e) => 'cursor' in e && e.cursor) as { cursor: WaitCursorV3 };

      const second = await collect(last.cursor, read);
      const secondLines = second
        .filter((e) => e.type === 'progress')
        .map((e) => (e as { message: string }).message.split(' ')[0]);

      const bTailStart = 111; // B's 20-line tail is seq 111..130
      const replayedB = secondLines.filter((l) => l.startsWith('B') && Number(l.slice(1)) < bTailStart);

      expect(replayedB.length).toBe(0);
    });
  });
});

it.each(['v0.10.15', 'v0.10.17', 'v0.10.18'] as const)(
  'released %s clients hold pending repairs and refuse failed artifacts',
  async (tag) => {
    const directories: string[] = [];
    try {
      const released = await loadReleasedWait(tag, directories);
      for (const availability of [
        { kind: 'repair-pending', ageUncertain: false },
        { kind: 'failed', cause: 'repair-failed', retryScheduled: true },
        { kind: 'failed', cause: 'cutoff-untrusted', retryScheduled: true },
      ] as const) {
        const job = { ...admitted('a'), availability };
        const parsed = released.jobWaitSchema.parse({
          jobIds: ['a'],
          projectRoot: '/tmp',
          timeoutSeconds: 1,
          ...(tag === 'v0.10.15' ? {} : { supportsWaitV2: true }),
        });
        const request = { ...(parsed as object), timeoutSeconds: 0 } as never;
        const read = () =>
          collect(
            readWaitSession({ request, time: createRealTimePort(), activeEpochKey: 'epoch-E', read: () => [job] }),
          );
        if (availability.kind === 'failed') {
          await expect(read()).rejects.toMatchObject({
            code: 'wait_epoch_unsupported',
            message: expect.stringContaining('jobs detail a'),
          });
          continue;
        }
        const events = await read();
        expect(events.some((event) => event.type === 'terminal')).toBe(false);
        const waiting = events.at(-1)!;
        expect(waiting).toMatchObject({ type: 'waiting', waitingJobIds: ['a'] });
        expect(released.parseWaitStreamEventValue(waiting)).toMatchObject({ type: 'waiting' });
        if ('cursor' in waiting && waiting.cursor?.version === 'jobs.wait.v2')
          expect(waiting.cursor.deliveredJobIds).toEqual([]);
        const text = released.formatWaitWaiting(waiting, released.serializeWaitCursor({ afterSeq: 0 }), ['a']);
        expect(text).toContain('coral-cli wait jobs a');
        expect(text).toContain('(cursor: ');
        job.availability = { kind: 'available', resultPath: '/results/a' } as never;
        const repaired = await collect(
          readWaitSession({ request, time: createRealTimePort(), activeEpochKey: 'epoch-E', read: () => [job] }),
        );
        expect(released.parseWaitStreamEventValue(repaired.find((event) => event.type === 'terminal'))).toMatchObject({
          type: 'terminal',
          resultPath: '/results/a',
        });
      }
    } finally {
      for (const dir of directories) rmSync(dir, { recursive: true, force: true });
    }
  },
);

it('mid-stream discovery unknown retains a legacy continuation', async () => {
  let poll = 0;
  let mono = 0n;
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['a'], supportsWaitV2: true, timeoutSeconds: 1 },
      time: {
        ...createRealTimePort(),
        monotonicNow: () => mono,
        sleep: async (ms) => {
          mono += BigInt(ms);
        },
      },
      activeEpochKey: 'epoch-E',
      read: () =>
        ++poll === 1
          ? [admitted('a', [], false)]
          : [{ jobId: 'a', disposition: 'discovery-unknown', sourceRead: 'transient-unknown' }],
    }),
  );
  expect(events.at(-1)).toMatchObject({
    type: 'waiting',
    waitingJobIds: ['a'],
    cursor: { version: 'jobs.wait.v2', locations: { a: 'epoch-E' } },
  });
});

it('legacy progress preserves released bytes including overlong lines', async () => {
  const message = 'x'.repeat(5000) + '\nsecond line';
  const job = admitted('a', [[1, message]]);
  for (const supportsWaitV2 of [false, true]) {
    const events = await collect(
      readWaitSession({
        request: { jobIds: ['a'], supportsWaitV2, timeoutSeconds: 0 },
        time: createRealTimePort(),
        activeEpochKey: 'epoch-E',
        read: () => [job],
      }),
    );
    expect(events.find((event) => event.type === 'progress')).toMatchObject({ message });
  }
});

it.each([false, true])('refuses every failed artifact for a released reader, retry=%s', async (retryScheduled) => {
  const job = admitted('a');
  job.availability = { kind: 'failed', cause: 'repair-failed', retryScheduled };
  await expect(
    collect(
      readWaitSession({
        request: { jobIds: ['a'], supportsWaitV2: true, timeoutSeconds: 0 },
        time: createRealTimePort(),
        activeEpochKey: 'epoch-E',
        read: () => [job],
      }),
    ),
  ).rejects.toMatchObject({
    code: 'wait_epoch_unsupported',
    message: expect.stringContaining('coral-cli jobs detail a'),
  });
});

it('released terminal keeps a transient sibling in the remaining batch', async () => {
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['a', 'b'], supportsWaitV2: true, timeoutSeconds: 0 },
      time: createRealTimePort(),
      activeEpochKey: 'epoch-E',
      read: () => [admitted('a'), { jobId: 'b', disposition: 'discovery-unknown' }],
    }),
  );
  expect(events.at(-1)).toMatchObject({ type: 'terminal', remainingJobIds: ['b'] });
});

it('launch follow drains early progress rather than selecting a tail', async () => {
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['a'], supportsWaitV3: true, drainProgress: true, timeoutSeconds: 0 },
      time: createRealTimePort(),
      activeEpochKey: 'epoch-E',
      read: () => [
        admitted(
          'a',
          Array.from({ length: 21 }, (_, i) => [i + 1, `early-${i}`]),
        ),
      ],
    }),
  );
  expect(events.filter((e) => e.type === 'progress')).toHaveLength(21);
});

it('windows snapshot content and diagnostics before encoding', () => {
  const job = admitted('a');
  job.detail!.exit!.content = 'a"\\🙂\n'.repeat(100_000);
  job.detail!.exit!.diagnostics.warnings = ['w'.repeat(1_000_000)];
  const session = new WaitSession(['a']);
  session.reconcile([job]);
  const stringify = vi.spyOn(JSON, 'stringify');
  const snapshot = selectWaitSnapshot(session);
  expect(snapshot.jobs[0].terminal!.contentOmitted).toBe(true);
  expect(stringify.mock.calls.every(([v]) => typeof v !== 'string' || v.length <= 4096)).toBe(true);
  expect(
    stringify.mock.calls.every(
      ([v]) => !v || typeof v !== 'object' || !('diagnostics' in v) || JSON.stringify(v).length < 10_000,
    ),
  ).toBe(true);
});

function advancingTime() {
  let now = 0n;
  return {
    ...createRealTimePort(),
    monotonicNow: () => now,
    sleep: async (ms: number) => {
      now += BigInt(ms);
    },
  };
}

it('states held progress before delivering a legacy terminal', async () => {
  const a = admitted('a');
  a.sourceRead = 'transient-unknown';
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['a'], supportsWaitV2: true, timeoutSeconds: 0 },
      time: createRealTimePort(),
      activeEpochKey: 'epoch-E',
      read: () => [a],
    }),
  );
  expect(events[0]).toMatchObject({ type: 'progress', message: expect.stringContaining('was not shown') });
  expect(events.at(-1)).toMatchObject({ type: 'terminal' });
});

it('cursorless snapshot omission retains the current tail watermark', () => {
  const job = admitted(
    'a',
    [
      [1, 'old'],
      [30, 'x'.repeat(4000)],
    ],
    false,
  );
  job.message = 'm'.repeat(2 * 1024 * 1024 - 2300);
  const session = new WaitSession(['a']);
  session.reconcile([job]);
  const snapshot = selectWaitSnapshot(session, 1);
  expect(snapshot.jobs[0].progress).toEqual([]);
  expect(snapshot.cursor.epochs[0].watermark).toBe(29);
});

it('settles a failed artifact silently after a legacy terminal was acknowledged', async () => {
  const job = admitted('a');
  job.availability = { kind: 'failed', cause: 'cutoff-untrusted', retryScheduled: true };
  await expect(
    collect(
      readWaitSession({
        request: {
          jobIds: ['a'],
          supportsWaitV2: true,
          cursor: {
            version: 'jobs.wait.v2',
            positions: { 'epoch-E': 1000 },
            locations: { a: 'epoch-E' },
            deliveredJobIds: ['a'],
          },
          timeoutSeconds: 0,
        },
        time: createRealTimePort(),
        activeEpochKey: 'epoch-E',
        read: () => [job],
      }),
    ),
  ).resolves.toEqual([expect.objectContaining({ type: 'waiting', waitingJobIds: [] })]);
});

it('does not spend unknown-read retries on a deferred poll', async () => {
  let poll = 0;
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['a'], supportsWaitV3: true, timeoutSeconds: 20 },
      time: advancingTime(),
      activeEpochKey: 'epoch-E',
      read: () => {
        poll++;
        if (poll === 1) return [{ jobId: 'a', disposition: 'discovery-unknown' }];
        if (poll < 5) return [{ jobId: 'a', disposition: 'discovery-unknown', observationDeferred: true }];
        return [admitted('a')];
      },
    }),
  );
  expect(events.some((event) => event.type === 'terminal')).toBe(true);
  expect(poll).toBe(5);
});

it('gives a legacy cursor without a warning sequence slot a runnable held-progress refusal', async () => {
  const job = admitted('a');
  job.sourceRead = 'transient-unknown';
  await expect(
    collect(
      readWaitSession({
        request: { jobIds: ['a'], cursor: { afterSeq: 999 }, timeoutSeconds: 0 },
        time: createRealTimePort(),
        activeEpochKey: 'epoch-E',
        read: () => [job],
      }),
    ),
  ).rejects.toMatchObject({
    code: 'wait_epoch_unsupported',
    message: expect.stringContaining('jobs detail a to inspect'),
  });
});

it('carries the failed set code on the last progress batch before stream closure', async () => {
  const events = await collect(
    readWaitSession({
      request: {
        jobIds: ['a'],
        supportsWaitV3: true,
        timeoutSeconds: 0,
        cursor: {
          version: 'jobs.wait.v3',
          epochs: [{ token: waitEpochToken('epoch-E'), watermark: 4, lineOffset: 0 }],
          jobs: [{ hash: waitJobHash('a'), epoch: 0, flags: 1 }],
        },
      },
      time: new VirtualTime(),
      activeEpochKey: 'epoch-E',
      read: () => [
        admitted(
          'a',
          [
            [3, 'old'],
            [5, 'last'],
          ],
          true,
          'epoch-E',
          true,
        ),
      ],
    }),
  );
  expect(events.find((event) => event.type === 'progress')).toMatchObject({ exitCode: 42, cursor: { jobs: [] } });
});

it('carries the refused set code before the completion notice', async () => {
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['ghost'], supportsWaitV3: true, timeoutSeconds: 0 },
      time: new VirtualTime(),
      activeEpochKey: 'epoch-E',
      read: () => [{ jobId: 'ghost', disposition: 'missing' }],
    }),
  );
  expect(events[0]).toMatchObject({ type: 'disposition', exitCode: 1 });
});

it('applies a cursorless tail when a member first becomes readable', async () => {
  const time = new VirtualTime();
  let polls = 0;
  const stream = readWaitSession({
    request: { jobIds: ['a'], supportsWaitV3: true, timeoutSeconds: 1 },
    time,
    activeEpochKey: 'epoch-E',
    read: () =>
      ++polls === 1
        ? [{ jobId: 'a', disposition: 'discovery-unknown' }]
        : [
            admitted(
              'a',
              Array.from({ length: 3000 }, (_, i) => [i + 1, `line-${i + 1}`]),
              false,
            ),
          ],
  });
  const result = collect(stream);
  await flushMicrotasks(20);
  time.tick(250);
  await flushMicrotasks(20);
  time.tick(1000);
  const events = await result;
  const progress = events.filter((event) => event.type === 'progress');
  expect(progress).toHaveLength(20);
  expect(progress[0]).toMatchObject({ message: 'line-2981' });
});

it('persists tail selection across a snapshot of a held epoch', () => {
  const job = admitted(
    'a',
    Array.from({ length: 3000 }, (_, i) => [i + 1, `line-${i + 1}`]),
    false,
  );
  const held = new WaitSession(['a']);
  held.reconcile([{ ...job, sourceRead: 'transient-unknown' }]);
  const snapshot = selectWaitSnapshot(held, 20);
  const resumed = new WaitSession(['a'], snapshot.cursor);
  resumed.reconcile([job]);
  const readable = selectWaitSnapshot(resumed);
  expect(readable.jobs[0].progress).toHaveLength(20);
  expect(readable.jobs[0].progress[0]).toBe('line-2981');
});

it.each([false, true])('settles delivered legacy artifacts silently (v2=%s)', async (v2) => {
  const time = new VirtualTime();
  let polls = 0;
  const result = collect(
    readWaitSession({
      request: {
        jobIds: ['a', 'b'],
        supportsWaitV2: v2,
        timeoutSeconds: 1,
        cursor: v2
          ? {
              version: 'jobs.wait.v2',
              positions: { 'epoch-E': 0 },
              locations: { a: 'epoch-E', b: 'epoch-E' },
              deliveredJobIds: ['a'],
            }
          : { afterSeq: 0, deliveredJobIds: ['a'] },
      },
      time,
      activeEpochKey: 'epoch-E',
      read: () => {
        const settled = ++polls > 1;
        return [
          {
            ...admitted('a'),
            availability: settled
              ? { kind: 'available', resultPath: '/a.md' }
              : { kind: 'repair-pending', ageUncertain: false },
          },
          admitted('b', [], settled),
        ];
      },
    }),
  );
  await flushMicrotasks(20);
  time.tick(250);
  await flushMicrotasks(20);
  time.tick(1000);
  const events = await result;
  expect(events.at(-1)).toMatchObject({ type: 'terminal', jobId: 'b', remainingJobIds: [] });
});

it('attaches a V3 cursor only to the last progress event in the batch', async () => {
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['a'], supportsWaitV3: true, timeoutSeconds: 0 },
      time: new VirtualTime(),
      activeEpochKey: 'epoch-E',
      read: () => [
        admitted(
          'a',
          [
            [1, 'one'],
            [2, 'two'],
          ],
          false,
        ),
      ],
    }),
  );
  const progress = events.filter((event) => event.type === 'progress');
  expect(progress[0]).not.toHaveProperty('cursor');
  expect(progress.at(-1)).toHaveProperty('cursor');
  expect(progress.every((event) => parseWaitStreamEventValue(event) !== null)).toBe(true);
});

it('bounds terminal-boundary searches independently of a versionless progress backlog', async () => {
  const job = admitted(
    'a',
    Array.from({ length: 64 }, (_, i) => [i + 1, `line-${i}`]),
  );
  const find = vi.spyOn(job.detail!.events, 'find');
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['a'], timeoutSeconds: 0 },
      time: new VirtualTime(),
      activeEpochKey: 'epoch-E',
      read: () => [job],
    }),
  );
  expect(events.filter((event) => event.type === 'progress')).toHaveLength(64);
  expect(find.mock.calls.length).toBeLessThanOrEqual(10);
});

it('shares stream admission and reads only a bounded tail or the requested epoch suffix', async () => {
  const f = createTerminalExportFixture();
  try {
    for (let i = 0; i < 100; i++) f.store.appendProgress(f.jobId, 'session-1', `line-${i}`);
    let rows = 0;
    let reads = 0;
    const coordinator = new WaitCoordinator({
      sessionManager: { get: () => null } as never,
      launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
      eventBus: { on() {}, off() {} } as never,
      time: f.runtime.time,
      loadJobProjectionDetail: (id) => f.store.loadJobProjectionDetail(id),
      readJobEvents: (id, after, window) => {
        reads++;
        const result = f.store.readJobEvents(id, false, after, window);
        rows += result.length;
        return result;
      },
      aggregateWorkflowUsage: () => undefined,
      subscribeJobEvents: () => (async function* () {})(),
      getCurrentJournalSeq: () => (f.db.prepare('SELECT MAX(seq) AS seq FROM events').get() as { seq: number }).seq,
      currentJobEpochKey: () => f.epochKey,
      resultJobsRoot: f.runtime.paths.coral.exports.jobsRoot,
      observeResultAvailability: () => ({ kind: 'available', resultPath: '/x' }),
    });
    const addressing = new JobAddressing(
      f.index.readOnlyView(),
      {
        epochKey: () => f.epochKey,
        detail: () => null,
        abort: () => ({ kind: 'answered', result: { aborted: [], notFound: [] } }),
        readWaitAdmissions: (ids, key, session) => coordinator.readWaitAdmissions(ids, key, session),
      },
      () => false,
      () => 'pending',
      undefined,
      () => ({ kind: 'available', resultPath: '/x' }),
    );
    const request = { jobIds: [f.jobId], supportsWaitV3: true, timeoutSeconds: 0 };
    const admittedRequest = Object.assign(request, { admissions: addressing.admitWait(request) });
    const events = await collect(addressing.waitStream(admittedRequest));
    expect(reads).toBe(1);
    expect(rows).toBeLessThanOrEqual(21);
    const last = events.at(-1)!;
    rows = 0;
    const resumed = addressing.snapshot({ jobIds: [f.jobId], supportsWaitV3: true, cursor: last.cursor });
    expect(resumed.jobs[0].progress).toEqual([]);
    expect(rows).toBe(0);
  } finally {
    f.close();
  }
});

it.each(['v0.10.15', 'v0.10.16', 'v0.10.17', 'v0.10.18'] as const)(
  'gives %s runnable held-progress remediation without --full',
  async (tag) => {
    const directories: string[] = [];
    const released = await loadReleasedWait(tag, directories);
    const job = { ...admitted('a', [], true), sourceRead: 'transient-unknown' as const };
    try {
      const events = await collect(
        readWaitSession({
          request: { jobIds: ['a'], supportsWaitV2: tag !== 'v0.10.15', timeoutSeconds: 0 },
          time: new VirtualTime(),
          activeEpochKey: 'epoch-E',
          read: () => [job],
        }),
      );
      const text = events
        .map((event) => released.parseWaitStreamEventValue(event))
        .map((event) => (event && 'message' in event ? (event.message ?? '') : ''))
        .join('\n');
      expect(text).toContain('coral-cli jobs detail a');
      expect(text).not.toContain('--full');
    } finally {
      for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    }
  },
);

it.each([false, true])('a legacy failed artifact refuses only its affected job, v2=%s', async (v2) => {
  const a = admitted('a');
  const failed = {
    ...admitted('b'),
    availability: { kind: 'failed' as const, cause: 'repair-failed' as const, retryScheduled: true },
  };
  let cursor: WaitCursor | undefined;
  const request = {
    jobIds: ['a', 'b'],
    supportsWaitV2: v2,
    timeoutSeconds: 0,
    onLegacyCursor: (next: WaitCursor) => {
      cursor = next;
    },
  };
  const events = await collect(
    readWaitSession({ request, time: new VirtualTime(), activeEpochKey: 'epoch-E', read: () => [a, failed] }),
  );
  const terminal = events.find((event) => event.type === 'terminal')!;
  cursor = terminal.cursor ?? cursor;
  expect(terminal).toMatchObject({ jobId: 'a', remainingJobIds: ['b'] });
  await expect(
    collect(
      readWaitSession({
        request: { ...request, cursor },
        time: new VirtualTime(),
        activeEpochKey: 'epoch-E',
        read: () => [a, failed],
      }),
    ),
  ).rejects.toThrow('coral-cli jobs detail b');
});
