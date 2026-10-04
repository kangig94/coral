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
    expect(events.filter((event) => event.type === 'progress')).toHaveLength(500);
    expect(split.mock.calls.length).toBeLessThanOrEqual(2100);
  } finally {
    split.mockRestore();
  }
});

it('closes a v2 progress-only tail and preserves the delivered cursor membership', async () => {
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
  const second = await read(first.find((event) => event.type === 'terminal')!.cursor);
  expect(second.at(-1)).toMatchObject({
    type: 'waiting',
    waitingJobIds: [],
    cursor: { locations: { a: 'epoch-E' }, deliveredJobIds: ['a'] },
  });
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
    expect(observations).toBe(2);
    expect(waiting).toMatchObject({ waitingJobIds: ['live-job'] });
    expect(waiting?.carrierUnknownJobIds).toBeUndefined();
  });
  it('downgrades coverage after a failed refresh', async () => {
    const job = admitted('live-job', [], false);
    let observations = 0;
    const stream = readWaitSession({
      request: { jobIds: ['live-job'], supportsWaitV3: true, timeoutSeconds: 0.3 },
      time: createRealTimePort(),
      activeEpochKey: 'epoch-E',
      read: () => [job],
      observe: (session) => {
        if (++observations === 1) session.observeCoverage(['live-job'], [], 10);
        else throw new Error('unobservable');
      },
    });
    const events = [];
    for await (const event of stream) events.push(event);
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
