import { nextDelivered } from '#tests/helpers/wait-stream.js';
import { testProgressVisit, observeWaitRead } from '#tests/helpers/wait-progress.js';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';
import { WaitCoordinator } from '#src/jobs/shell/wait.js';
import { JobAddressing } from '#src/jobs/addressing.js';
import { waitEpochToken, waitJobHash } from '#src/jobs/wait/cursor.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readWaitSession } from '#src/jobs/wait/reader.js';
import { WaitSession } from '#src/jobs/wait/session.js';
import type { WaitAdmission } from '#src/jobs/wait/session.js';
import { parseWaitSnapshot } from '#src/jobs/wait/snapshot.js';
import { selectWaitSnapshot } from '#tests/helpers/wait-progress.js';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import type { TimePort } from '#src/infra/port-types.js';

import { admitted, savedCursor } from '#tests/helpers/wait-session.js';
import type { WaitStreamEvent, WaitCursor } from '#src/jobs/wait/contract.js';

import { advanceWaitRenderCursor, parseWaitStreamEventValue } from '#src/jobs/wait/stream-event.js';
import { isFinalWaitEvent, type ProgressVisit } from '#src/jobs/wait/contract.js';
import { progressPage, progressTail } from '#src/jobs/wait/progress-page.js';
import { waitCursorForJobs } from '#src/jobs/wait/cursor.js';
import { progressVisitFromEvents } from '#tests/helpers/wait-progress.js';
import { serializeWaitCursor } from '#src/jobs/wait/cursor.js';
import { formatWaitSnapshot, formatWaitWaiting, formatWaitProgress, formatWaitTerminal } from '#src/cli/format/wait.js';

async function collectWithFrames(stream: AsyncGenerator<WaitStreamEvent>): Promise<WaitStreamEvent[]> {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Delivered events: cursor frames only move the client frontier and are asserted by their own tests. */
async function collect(stream: AsyncGenerator<WaitStreamEvent>): Promise<WaitStreamEvent[]> {
  return (await collectWithFrames(stream)).filter((event) => event.type !== 'cursor');
}

/** A plain time port whose clock methods a test may override, since spreading a class instance drops them. */
function virtualTimeMethods(): TimePort {
  const time = new VirtualTime();
  return {
    now: () => time.now(),
    monotonicNow: () => time.monotonicNow(),
    sleep: (ms, options) => time.sleep(ms, options),
    setTimeout: (fn, ms) => time.setTimeout(fn, ms),
    clearTimeout: (handle) => time.clearTimeout(handle),
    setInterval: (fn, ms) => time.setInterval(fn, ms),
    clearInterval: (handle) => time.clearInterval(handle),
  };
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
        request: { jobIds: ['a'], timeoutSeconds: 0 },
        time: new VirtualTime(),
        read: observeWaitRead(() => [job]),
        visit: testProgressVisit,
      }),
    );
    expect(events.filter((event) => event.type === 'progress')).toHaveLength(20);
    expect(split.mock.calls.length).toBeLessThanOrEqual(100);
  } finally {
    split.mockRestore();
  }
});

it('keeps completed live coverage when a later refresh outlives the deadline', async () => {
  const time = new VirtualTime();
  let calls = 0;
  const stream = readWaitSession({
    request: { jobIds: ['a'], timeoutSeconds: 1 },
    time,
    read: observeWaitRead(() => [admitted('a', [], false)]),
    visit: testProgressVisit,
    observe: (session) => {
      if (++calls === 1) session.observeCoverage(['a'], [], 3);
      else return new Promise<void>(() => {});
    },
  });
  const next = nextDelivered(stream);
  await flushMicrotasks(20);
  for (let i = 0; i < 4; i++) {
    time.tick(250);
    await flushMicrotasks(20);
  }
  expect((await next).value).toMatchObject({ type: 'waiting' });
  expect((await next).value).not.toHaveProperty('carrierUnknownJobIds');
  await stream.return(undefined);
});

it('refreshes carrier coverage from live to unknown within the original deadline', async () => {
  const time = new VirtualTime();
  let calls = 0;
  const stream = readWaitSession({
    request: { jobIds: ['a'], timeoutSeconds: 1 },
    time,
    read: observeWaitRead(() => [admitted('a', [], false)]),
    visit: testProgressVisit,
    observe: (session) => {
      session.observeCoverage(['a'], ++calls === 1 ? [] : ['a'], 0);
    },
  });
  const next = nextDelivered(stream);
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
    request: { jobIds: ['a'], timeoutSeconds: 1 },
    time,
    read: observeWaitRead(() => [admitted('a', [], false)]),
    visit: testProgressVisit,
    observe: async (session, signal) => {
      calls++;
      observedSignal = signal;
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      if (!signal.aborted) session.observeCoverage(['a'], [], 0);
    },
  });
  const next = nextDelivered(stream);
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
    let cursor: WaitCursor;
    if (direction === 'snapshot-to-stream') {
      const session = new WaitSession(['a', 'u']);
      session.reconcile(unresolved);
      cursor = selectWaitSnapshot(session, 20).cursor;
    } else {
      const events = await collect(
        readWaitSession({
          request: { jobIds: ['a', 'u'] },
          time: new VirtualTime(),
          read: observeWaitRead(() => unresolved),
          visit: testProgressVisit,
        }),
      );
      cursor = events.find((event) => event.type === 'terminal')!.cursor;
    }
    const joined = [a, admitted('u', [[2, 'u below 100']], false)];
    if (direction === 'snapshot-to-stream') {
      const events = await collect(
        readWaitSession({
          request: { jobIds: ['a', 'u'], cursor, timeoutSeconds: 0 },
          time: new VirtualTime(),
          read: observeWaitRead(() => joined),
          visit: testProgressVisit,
        }),
      );
      expect(events.filter((event) => event.type === 'progress').map((event) => event.message)).toEqual([
        'u below 100',
      ]);
      expect(events.filter((event) => event.type === 'terminal')).toEqual([]);
      expect(events.some((event) => event.type === 'notice' && event.message.includes('membership changed'))).toBe(
        false,
      );
      cursor = (
        'cursor' in events.at(-1)!
          ? (events.at(-1)! as Extract<WaitStreamEvent, { type: 'waiting' }>).cursor
          : undefined
      ) as WaitCursor;
    } else {
      const session = new WaitSession(['a', 'u'], cursor);
      session.reconcile(joined);
      const snapshot = selectWaitSnapshot(session);
      expect(snapshot.jobs[1].progress).toEqual(['u below 100']);
      expect(snapshot.jobs[0].alreadyCollected).toBe(true);
      expect(snapshot.jobs[0].terminal).toBeUndefined();
      expect(snapshot.notices.some((notice) => notice.includes('membership changed'))).toBe(false);
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
      request: { jobIds: ['a', 'b'], cursor: session.cursor() },
      time: new VirtualTime(),
      read: observeWaitRead(() => [a, b]),
      visit: testProgressVisit,
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
      request: { jobIds: ['a'], timeoutSeconds: 1 },
      time,
      read: observeWaitRead(() => [a]),
      visit: testProgressVisit,
      observe: () => {
        if (observer === 'throws') throw new Error('observer failed');
      },
    });
    const next = nextDelivered(stream);
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
      request: { jobIds: ['a'], cursor: session.cursor() },
      time: new VirtualTime(),
      read: observeWaitRead(() => [a]),
      visit: testProgressVisit,
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
    request: { jobIds: ['u'], timeoutSeconds: 1 },
    time,
    read: observeWaitRead(() =>
      closure ? [{ jobId: 'u', disposition: 'outcome-unrecoverable' }] : [admitted('u', [], false, 'old-epoch')],
    ),
    visit: testProgressVisit,
  });
  const next = nextDelivered(stream);
  await flushMicrotasks(20);
  closure = true;
  time.tick(250);
  await flushMicrotasks(20);
  await expect(next).resolves.toMatchObject({ value: { type: 'disposition', disposition: 'outcome-unrecoverable' } });
  await expect(nextDelivered(stream)).resolves.toMatchObject({
    value: { type: 'waiting', waitingJobIds: [], exitCode: 1 },
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
    request: { jobIds: ['a', 'u'], timeoutSeconds: 1, cursor: saved },
    time,
    read: observeWaitRead(() => [
      a,
      resolved ? admitted('u', [[2, 'u2']], false) : { jobId: 'u', disposition: 'discovery-unknown' },
    ]),
    visit: testProgressVisit,
  });
  expect((await nextDelivered(stream)).value).toMatchObject({ type: 'disposition', disposition: 'discovery-unknown' });
  const next = nextDelivered(stream);
  await flushMicrotasks(20);
  resolved = true;
  time.tick(250);
  await flushMicrotasks(20);
  expect((await next).value).toMatchObject({ type: 'progress', jobId: 'u', message: 'u2' });
  const final = nextDelivered(stream);
  await flushMicrotasks(20);
  time.tick(1000);
  expect((await final).value).toMatchObject({
    type: 'waiting',
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
        resultPath: '/r/a',
        availability: { kind: 'available', resultPath: '/r/a' },
        cursor: { jobs: [] },
        exitCode: 0,
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
    const time = new VirtualTime();
    const stream = readWaitSession({
      request: { jobIds: ['live-job'], timeoutSeconds: 590 },
      time,
      read: observeWaitRead(() => (++reads === 1 ? [job] : [backlog])),
      visit: testProgressVisit,
      observe: async (session, signal) => {
        observations++;
        if (observations === 1) session.observeCoverage(['live-job'], [], 601);
        else await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    });
    let waiting: WaitStreamEvent | undefined;
    const run = (async () => {
      for await (const event of stream) if (event.type === 'waiting') waiting = event;
    })();
    await flushMicrotasks(20);
    time.tick(250);
    await run;
    expect(observations).toBe(1);
    expect(waiting).toMatchObject({ waitingJobIds: ['live-job'] });
    expect(waiting).not.toHaveProperty('carrierUnknownJobIds');
  });
  it('downgrades coverage after a failed refresh', async () => {
    const time = new VirtualTime();
    const job = admitted('live-job', [], false);
    let observations = 0;
    const stream = readWaitSession({
      request: { jobIds: ['live-job'], timeoutSeconds: 0.3 },
      time,
      read: observeWaitRead(() => [job]),
      visit: testProgressVisit,
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
      request: { jobIds: ['a', 'b'] },
      time: new VirtualTime(),
      read: observeWaitRead(() => jobs),
      visit: testProgressVisit,
    });
    expect((await nextDelivered(stream)).value).toMatchObject({
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
      request: { jobIds: ['a'], cursor: first.cursor() },
      time: new VirtualTime(),
      read: observeWaitRead(() => [job]),
      visit: testProgressVisit,
    });
    const events = await collect(stream);
    expect(events).toEqual([expect.objectContaining({ type: 'waiting', waitingJobIds: [], exitCode: 0 })]);
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
    expect(parseWaitStreamEventValue({ type: 'notice', message: 'ok', future: true })).toMatchObject({ message: 'ok' });
    expect(
      parseWaitStreamEventValue({
        type: 'disposition',
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
    const input = {
      jobs: [{ hash: waitJobHash('a'), epoch: waitEpochToken('epoch-E'), seq: 7, lineOffset: 0, flags: 0 }],
    };
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
    request: { jobIds: ['a'], timeoutSeconds: 0 },
    internal: true,
    time: new VirtualTime(),
    read: observeWaitRead(() => [
      admitted(
        'a',
        Array.from({ length: 501 }, (_, index) => [index + 1, `line ${index}`]),
      ),
    ]),
    visit: testProgressVisit,
  }))
    events.push(event);
  expect(events.filter((event) => event.type === 'progress')).toHaveLength(501);
  expect(events.some((event) => event.type === 'terminal')).toBe(true);
  expect(events.some((event) => event.type === 'waiting')).toBe(false);
});

it('crosses a timer boundary before returning an immediate internal deadline without an outcome', async () => {
  const time = new VirtualTime();
  const stream = readWaitSession({
    request: { jobIds: ['a'], timeoutSeconds: 0 },
    internal: true,
    time,
    read: observeWaitRead(() => [admitted('a', [], false)]),
    visit: testProgressVisit,
  });
  let returned = false;
  const next = nextDelivered(stream).then((event) => {
    returned = true;
    return event;
  });
  await flushMicrotasks(20);
  expect(returned).toBe(false);
  time.tick(1);
  expect((await next).value).toMatchObject({ type: 'waiting' });
  await stream.return(undefined);
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
      request: { jobIds: ['a'], timeoutSeconds: 590 },
      time: { ...virtualTimeMethods(), monotonicNow: () => monotonic, sleep },
      read: observeWaitRead(read),
      visit: testProgressVisit,
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
      request: { jobIds: ['a'], timeoutSeconds: 0 },
      time: new VirtualTime(),
      internal: true,
      read: observeWaitRead(() => [admitted('a', [[1, 'first\nsecond\nthird']])]),
      visit: testProgressVisit,
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
      request: { jobIds: ['A', 'U'], timeoutSeconds: 0 },
      time: new VirtualTime(),
      read: observeWaitRead(() => [a, u]),
      visit: testProgressVisit,
    }),
  );
  expect(events.find((event) => event.type === 'terminal')).toMatchObject({ remainingJobIds: ['U'] });
  expect(
    events.some((event) => event.type === 'notice' && event.message.includes('U') && event.message.includes('is held')),
  ).toBe(true);
  const session = new WaitSession(['A', 'U']);
  session.reconcile([a, u]);
  const snapshot = selectWaitSnapshot(session, 20);
  expect(snapshot.remainingJobIds).toEqual(['U']);
  expect(snapshot.notices.some((notice) => notice.includes('U') && notice.includes('is held'))).toBe(true);
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
      request: { jobIds: ['LIVE', 'X'], timeoutSeconds: 589 },
      time: {
        ...virtualTimeMethods(),
        monotonicNow: () => mono,
        sleep: async (ms) => {
          mono += BigInt(ms);
        },
      },
      read: observeWaitRead(() => [live, unknown]),
      visit: testProgressVisit,
      observe: (session) => session.observeCoverage(['LIVE'], [], 1),
    }),
  );
  expect(mono).toBe(589000n);
  expect(events.at(-1)).toMatchObject({ type: 'waiting', waitingJobIds: ['LIVE', 'X'] });
});

it('settles a permanently unreadable retained outcome after delivery instead of keeping it in every continuation', async () => {
  const job = {
    ...admitted('h', [], true, 'epoch-OLD'),
    sourceRead: 'settled-unreadable' as const,
    progressUnknown: true,
  };
  const first = await collect(
    readWaitSession({
      request: { jobIds: ['h'], timeoutSeconds: 0 },
      time: new VirtualTime(),
      read: observeWaitRead(() => [job]),
      visit: testProgressVisit,
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

it('a settled source ends a wait on the first poll without a continuation', async () => {
  const read = vi.fn((): WaitAdmission[] => [
    { jobId: 'U', disposition: 'outcome-unreadable', sourceRead: 'settled-unreadable' },
  ]);
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['U'] },
      time: new VirtualTime(),
      read: observeWaitRead(read),
      visit: testProgressVisit,
    }),
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(events.at(-1)).toMatchObject({ type: 'waiting', exitCode: 1, cursor: { jobs: [] } });
});

it('rate limits idle carrier observation across forty polls', async () => {
  const time = new VirtualTime();
  const observe = vi.fn((session: WaitSession) => session.observeCoverage(['a'], [], 0));
  const stream = readWaitSession({
    request: { jobIds: ['a'], timeoutSeconds: 10 },
    time,
    read: observeWaitRead(() => [admitted('a', [], false)]),
    visit: testProgressVisit,
    observe,
  });
  const next = nextDelivered(stream);
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
      request: { jobIds: ['a'], cursor: middle.cursor(), timeoutSeconds: 0 },
      time: new VirtualTime(),
      read: observeWaitRead(() => [a]),
      visit: testProgressVisit,
    }),
  );
  expect(events.filter((event) => event.type === 'terminal')).toEqual([]);
  expect(events.at(-1)).toMatchObject({ type: 'waiting', exitCode: 0 });
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
      request: { jobIds: ['a', 'b'], timeoutSeconds: 0 },
      time: new VirtualTime(),
      read: observeWaitRead(() => jobs),
      visit: testProgressVisit,
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
    const cursor: WaitCursor = {
      jobs: [
        { hash: waitJobHash('a'), epoch: waitEpochToken('epoch-E'), seq: 4, lineOffset: 0, flags: 0 },
        { hash: waitJobHash('b'), epoch: waitEpochToken('epoch-E'), seq: 4, lineOffset: 0, flags: 0 },
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
        request: { jobIds: ['a', 'b'], timeoutSeconds: 2, cursor },
        time: advancingTime(),
        read: observeWaitRead(() => (++poll === 1 ? [a, bUnknown] : [a, b])),
        visit: testProgressVisit,
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
    const cursor: WaitCursor = {
      jobs: [
        { hash: waitJobHash('u'), epoch: waitEpochToken('epoch-E'), seq: 4, lineOffset: 0, flags: 0 },
        { hash: waitJobHash('a'), epoch: waitEpochToken('epoch-E'), seq: 4, lineOffset: 0, flags: 0 },
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
    const run = async (c: WaitCursor) =>
      collect(
        readWaitSession({
          request: { jobIds: ['u', 'a'], timeoutSeconds: 1, cursor: c },
          time: advancingTime(),
          read: observeWaitRead(() => [u, a]),
          visit: testProgressVisit,
        }),
      );
    const first = await run(cursor);
    expect(first.filter((e) => e.type === 'progress').map((e) => e.message)).toEqual(['a-5', 'a-6']);
    const last = first.at(-1) as Extract<WaitStreamEvent, { type: 'waiting' }>;

    const second = await run(last.cursor);
    const progress2 = second.filter((e) => e.type === 'progress').map((e) => e.message);

    expect(progress2).toEqual([]);
    const secondLast = second.at(-1) as Extract<WaitStreamEvent, { type: 'waiting' }>;
    const recovered = await collect(
      readWaitSession({
        request: { jobIds: ['u', 'a'], timeoutSeconds: 0, cursor: secondLast.cursor },
        time: advancingTime(),
        read: observeWaitRead(() => [admitted('u', [], false), a]),
        visit: testProgressVisit,
      }),
    );
    expect(recovered.filter((e) => e.type === 'progress').map((e) => e.message)).toEqual([]);
  });
});

describe('bounded tail selection excludes older history', () => {
  async function collect(cursor: WaitCursor | undefined, read: () => ReturnType<typeof admitted>[]) {
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
      request: { jobIds: ['A', 'B'], timeoutSeconds: 1, ...(cursor ? { cursor } : {}) },
      time,
      read: observeWaitRead(read),
      visit: testProgressVisit,
    }))
      events.push(event);
    return events;
  }

  describe('first bounded tail selection', () => {
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
      const last = [...first].reverse().find((e) => 'cursor' in e && e.cursor) as { cursor: WaitCursor };

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

it('launch follow drains early progress rather than selecting a tail', async () => {
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['a'], drainProgress: true, timeoutSeconds: 0 },
      time: new VirtualTime(),
      read: observeWaitRead(() => [
        admitted(
          'a',
          Array.from({ length: 21 }, (_, i) => [i + 1, `early-${i}`]),
        ),
      ]),
      visit: testProgressVisit,
    }),
  );
  expect(events.filter((e) => e.type === 'progress')).toHaveLength(21);
});

it('windows snapshot content and diagnostics before encoding', () => {
  const job = admitted('a');
  job.detail.exit!.content = 'a"\\🙂\n'.repeat(100_000);
  job.detail.exit!.diagnostics.warnings = ['w'.repeat(1_000_000)];
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
    ...virtualTimeMethods(),
    monotonicNow: () => now,
    sleep: async (ms: number) => {
      now += BigInt(ms);
    },
  };
}

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
  expect(snapshot.cursor.jobs[0].seq).toBe(29);
});

it('does not spend unknown-read retries on a deferred poll', async () => {
  let poll = 0;
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['a'], timeoutSeconds: 20 },
      time: advancingTime(),
      read: observeWaitRead(() => {
        poll++;
        if (poll === 1) return [{ jobId: 'a', disposition: 'discovery-unknown' }];
        if (poll < 5) return [{ jobId: 'a', disposition: 'discovery-unknown', observationDeferred: true }];
        return [admitted('a')];
      }),
      visit: testProgressVisit,
    }),
  );
  expect(events.some((event) => event.type === 'terminal')).toBe(true);
  expect(poll).toBe(5);
});

it('carries the failed set code on the last progress batch before stream closure', async () => {
  const events = await collect(
    readWaitSession({
      request: {
        jobIds: ['a'],
        timeoutSeconds: 0,
        cursor: {
          jobs: [{ hash: waitJobHash('a'), epoch: waitEpochToken('epoch-E'), seq: 4, lineOffset: 0, flags: 1 }],
        },
      },
      time: new VirtualTime(),
      read: observeWaitRead(() => [
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
      ]),
      visit: testProgressVisit,
    }),
  );
  expect(events.find((event) => event.type === 'progress')).not.toHaveProperty('exitCode');
  expect(events.at(-1)).toMatchObject({ type: 'waiting', exitCode: 42, cursor: { jobs: [] } });
});

it('carries the refused set code before the completion notice', async () => {
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['ghost'], timeoutSeconds: 0 },
      time: new VirtualTime(),
      read: observeWaitRead(() => [{ jobId: 'ghost', disposition: 'missing' }]),
      visit: testProgressVisit,
    }),
  );
  expect(events[0]).toMatchObject({ type: 'disposition' });
  expect(events[0]).not.toHaveProperty('exitCode');
  expect(events.at(-1)).toMatchObject({ type: 'waiting', exitCode: 1 });
});

it('applies a cursorless tail when a member first becomes readable', async () => {
  const time = new VirtualTime();
  let polls = 0;
  const stream = readWaitSession({
    request: { jobIds: ['a'], timeoutSeconds: 1 },
    time,
    read: observeWaitRead(() =>
      ++polls === 1
        ? [{ jobId: 'a', disposition: 'discovery-unknown' }]
        : [
            admitted(
              'a',
              Array.from({ length: 3000 }, (_, i) => [i + 1, `line-${i + 1}`]),
              false,
            ),
          ],
    ),
    visit: testProgressVisit,
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

it('attaches its job entry to every progress event', async () => {
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['a'], timeoutSeconds: 0 },
      time: new VirtualTime(),
      read: observeWaitRead(() => [
        admitted(
          'a',
          [
            [1, 'one'],
            [2, 'two'],
          ],
          false,
        ),
      ]),
      visit: testProgressVisit,
    }),
  );
  const progress = events.filter((event) => event.type === 'progress');
  expect(progress[0]).not.toHaveProperty('cursor');
  expect(progress.every((event) => 'entry' in event)).toBe(true);
  expect(progress.every((event) => !('cursor' in event) && !('exitCode' in event))).toBe(true);
  expect(progress.every((event) => parseWaitStreamEventValue(event) !== null)).toBe(true);
});

it('shares stream admission and reads only a bounded tail or the requested epoch suffix', async () => {
  const f = createTerminalExportFixture();
  try {
    for (let i = 0; i < 100; i++) f.store.appendProgress(f.jobId, 'session-1', `line-${i}`);
    let rows = 0;
    let reads = 0;
    const coordinator = new WaitCoordinator({
      visitProgress: (_epoch, visit) => {
        reads++;
        return f.store.visitProgress((source) =>
          visit({
            after: (id, after, count) => {
              const page = source.after(id, after, count);
              rows += page.rows.length;
              return page;
            },
            before: (id, before, count) => {
              const page = source.before(id, before, count);
              rows += page.rows.length;
              return page;
            },
          }),
        );
      },
      sessionManager: { get: () => null } as never,
      launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] } as never,
      eventBus: { on() {}, off() {} } as never,
      time: f.runtime.time,
      loadJobProjectionDetail: (id) => f.store.loadJobProjectionDetail(id),

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
        visitProgress: coordinator.visitProgress,
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
    const request = { jobIds: [f.jobId], timeoutSeconds: 0 };
    const admittedRequest = Object.assign(request, { admissions: addressing.admitWait(request) });
    const events = await collect(addressing.waitStream(admittedRequest));
    expect(reads).toBe(1);
    expect(rows).toBeLessThanOrEqual(41);
    const last = events.at(-1)!;
    rows = 0;
    const resumed = addressing.snapshot({
      jobIds: [f.jobId],
      cursor: 'cursor' in last ? last.cursor : undefined,
    });
    expect(resumed.jobs[0].progress).toEqual([]);
    expect(rows).toBe(0);
  } finally {
    f.close();
  }
});

it.each(['terminal', 'artifact', 'budget', 'deadline', 'all-refused', 'all-done'] as const)(
  '%s stream has exactly one final event, last, and non-final events carry no completion fields',
  async (kind) => {
    const job = admitted(
      'a',
      kind === 'budget' ? Array.from({ length: 600 }, (_, index) => [index + 1, `line-${index}`]) : [],
      kind !== 'deadline' && kind !== 'budget',
    );
    let cursor: WaitCursor | undefined;
    if (kind === 'artifact' || kind === 'all-done')
      cursor = {
        jobs: [
          {
            hash: waitJobHash('a'),
            epoch: waitEpochToken('epoch-E'),
            seq: 0,
            lineOffset: 0,
            flags: kind === 'artifact' ? 3 : 1,
          },
        ],
      };
    const events = await collectWithFrames(
      readWaitSession({
        request: { jobIds: ['a'], timeoutSeconds: 0, drainProgress: true, cursor },
        time: new VirtualTime(),
        read: observeWaitRead(() => (kind === 'all-refused' ? [{ jobId: 'a', disposition: 'missing' }] : [job])),
        visit: testProgressVisit,
      }),
    );
    const { isFinalWaitEvent } = await import('#src/jobs/wait/contract.js');
    expect(events.filter(isFinalWaitEvent)).toHaveLength(1);
    expect(isFinalWaitEvent(events.at(-1)!)).toBe(true);
    for (const event of events.filter((event) => !isFinalWaitEvent(event))) {
      expect(event).not.toHaveProperty('exitCode');
      if (event.type !== 'cursor') expect(event).not.toHaveProperty('cursor');
    }
    expect(events.at(-1)?.type).toBe(kind === 'terminal' ? 'terminal' : kind === 'artifact' ? 'artifact' : 'waiting');
  },
);

it('rejects completion fields on progress and notices, and incomplete finals', () => {
  const entry = { hash: waitJobHash('a'), epoch: waitEpochToken('epoch-E'), seq: 1, lineOffset: 0, flags: 0 };
  const progress = {
    type: 'progress',
    jobId: 'a',
    seq: 1,
    message: 'line',
    timing: { origin: 'runtime', originAt: '', emittedAt: '', elapsedMs: 0 },
    entry,
  };
  expect(() => parseWaitStreamEventValue({ ...progress, exitCode: 0 })).toThrow();
  expect(() =>
    parseWaitStreamEventValue({
      type: 'notice',
      message: 'notice',
      cursor: { jobs: [] },
    }),
  ).toThrow();
  expect(() =>
    parseWaitStreamEventValue({
      type: 'waiting',
      waitingJobIds: [],
      cursor: { jobs: [] },
    }),
  ).toThrow();
});

it('an internal discuss-style waiter survives the bounded transient retry schedule', async () => {
  const time = new VirtualTime();
  let readable = false;
  let settled = false;
  const events: WaitStreamEvent[] = [];
  const run = (async () => {
    for await (const event of readWaitSession({
      request: { jobIds: ['a'], timeoutSeconds: 20 },
      internal: true,
      time,
      read: observeWaitRead(() =>
        readable
          ? [admitted('a')]
          : [{ jobId: 'a', disposition: 'discovery-unknown', sourceRead: 'transient-unknown' }],
      ),
      visit: testProgressVisit,
    }))
      events.push(event);
    settled = true;
  })();
  await flushMicrotasks(30);
  for (let poll = 0; poll < 32; poll++) {
    time.tick(250);
    await flushMicrotasks(30);
  }
  expect(settled).toBe(false);
  expect(events.some((event) => event.type === 'terminal' || event.type === 'waiting')).toBe(false);
  readable = true;
  for (let poll = 0; poll < 20 && !settled; poll++) {
    time.tick(250);
    await flushMicrotasks(30);
  }
  await run;
  expect(events.at(-1)).toMatchObject({ type: 'terminal', jobId: 'a' });
});

describe('a frontier the client holds is complete at every cut (K1)', () => {
  type Jobs = Record<string, ReturnType<typeof admitted>>;
  const jobsWith = (events: Record<string, Array<[number, string]>>): Jobs =>
    Object.fromEntries(Object.entries(events).map(([id, messages]) => [id, admitted(id, messages, false)]));
  const frontierOf = (jobs: Jobs) =>
    Math.max(0, ...Object.values(jobs).flatMap((job) => job.detail.events.map((event) => event.seq)));

  async function cutRun(jobs: Jobs, cursor: WaitCursor | undefined, cut: (event: WaitStreamEvent) => boolean) {
    const ids = Object.keys(jobs);
    const shown: string[] = [];
    let client = cursor;
    for await (const raw of readWaitSession({
      request: { jobIds: ids, timeoutSeconds: 0, ...(cursor ? { cursor: waitCursorForJobs(cursor, ids) } : {}) },
      time: new VirtualTime(),
      read: () => Object.values(jobs),
      visit: progressVisitFromEvents(
        (id) => jobs[id].detail.events,
        () => frontierOf(jobs),
      ),
    })) {
      const event = parseWaitStreamEventValue(JSON.parse(JSON.stringify(raw))) as WaitStreamEvent;
      if (cut(event)) break;
      client = advanceWaitRenderCursor(client, event).cursor;
      if (event.type === 'progress') shown.push(`${event.jobId}:${event.message}`);
    }
    return { shown, client };
  }
  const beforeFinal = (event: WaitStreamEvent) => isFinalWaitEvent(event);
  const delivered = (shown: string[], jobId: string) => shown.filter((line) => line.startsWith(`${jobId}:`));
  const later = Array.from({ length: 40 }, (_, i) => [20 + i, `b${i + 1}`] as [number, string]);

  it('positions a silent member in the client frontier, so lines it gains before the reconnect all arrive', async () => {
    const first = await cutRun(
      jobsWith({
        A: [
          [10, 'a1'],
          [11, 'a2'],
          [12, 'a3'],
        ],
        B: [],
      }),
      undefined,
      beforeFinal,
    );
    expect(delivered(first.shown, 'A')).toEqual(['A:a1', 'A:a2', 'A:a3']);
    const second = await cutRun(
      jobsWith({
        A: [
          [10, 'a1'],
          [11, 'a2'],
          [12, 'a3'],
        ],
        B: later,
      }),
      first.client,
      () => false,
    );
    expect(delivered(second.shown, 'B')).toEqual(later.map(([, message]) => `B:${message}`));
    expect(delivered(second.shown, 'A')).toEqual([]);
  });

  it('keeps every member of a saved frontier when progress for one member arrives before a cut', async () => {
    const saved = savedCursor({ A: 15, B: 15 });
    const first = await cutRun(jobsWith({ A: [[16, 'a-new']], B: [[5, 'b-old']] }), saved, beforeFinal);
    expect(first.shown).toEqual(['A:a-new']);
    const second = await cutRun(
      jobsWith({ A: [[16, 'a-new']], B: [[5, 'b-old'], ...later] }),
      first.client,
      () => false,
    );
    expect(delivered(second.shown, 'B')).toEqual(later.map(([, message]) => `B:${message}`));
  });

  it('never replays what a saved frontier already covers for a silent member', async () => {
    const old = Array.from({ length: 30 }, (_, i) => [i + 1, `b-seen-${i + 1}`] as [number, string]);
    const jobs = jobsWith({ A: [[41, 'a-new']], B: old });
    const first = await cutRun(jobs, savedCursor({ A: 40, B: 40 }), beforeFinal);
    const second = await cutRun(jobs, first.client, () => false);
    expect(delivered([...first.shown, ...second.shown], 'B')).toEqual([]);
  });

  it('a cut right after a queued event leaves a frontier, never a synthetic legacy cursor', async () => {
    const queuedJob = admitted('Q', [], false);
    queuedJob.detail.status.phase = 'queued';
    queuedJob.queued = {
      type: 'queued',
      jobId: 'Q',
      queuePosition: 1,
      runningJobIds: [],
      timing: { origin: 'runtime', originAt: '', emittedAt: '', elapsedMs: 0 },
      jobKind: 'kb',
      systemTaskId: 't',
    };
    const history = Array.from({ length: 300 }, (_, i) => [i + 1, `old-${i + 1}`] as [number, string]);
    const jobs: Jobs = { Q: queuedJob, R: admitted('R', history, false) };
    let afterQueued = false;
    const first = await cutRun(jobs, undefined, (event) => {
      if (afterQueued) return true;
      afterQueued = event.type === 'queued';
      return false;
    });
    expect(first.client).not.toHaveProperty('afterSeq');
    expect(first.client?.jobs.map((entry) => entry.hash).sort()).toEqual([waitJobHash('Q'), waitJobHash('R')].sort());
    const second = await cutRun(jobs, first.client, () => false);
    expect(delivered(second.shown, 'R')).toEqual(history.slice(-20).map(([, message]) => `R:${message}`));
  });

  it('acknowledges a terminal only on an entry that names its epoch, in stream and snapshot', async () => {
    const time = new VirtualTime();
    let poll = 0;
    const read = (): WaitAdmission[] =>
      ++poll === 1
        ? [{ jobId: 'u', disposition: 'discovery-unknown', sourceRead: 'transient-unknown', message: 'held' }]
        : [{ ...admitted('u', [], true, 'epoch-H'), sourceRead: 'transient-unknown', progressUnknown: true }];
    const events: WaitStreamEvent[] = [];
    const run = (async () => {
      for await (const event of readWaitSession({
        request: { jobIds: ['u'], timeoutSeconds: 60 },
        time,
        read: observeWaitRead(read),
        visit: testProgressVisit,
      }))
        events.push(event);
    })();
    await flushMicrotasks(20);
    time.tick(300);
    await flushMicrotasks(50);
    await run;
    const terminal = events.find((event) => event.type === 'terminal');
    if (terminal?.type !== 'terminal') throw new Error('expected a terminal');
    expect(terminal.cursor.jobs[0].epoch).toBe(waitEpochToken('epoch-H'));
    expect(terminal.cursor.jobs[0].flags & 1).toBe(1);
    expect(() => parseWaitStreamEventValue(JSON.parse(JSON.stringify(terminal)))).not.toThrow();
    expect(() => serializeWaitCursor(terminal.cursor)).not.toThrow();
    const session = new WaitSession(['u']);
    session.reconcile(read());
    expect(parseWaitSnapshot(selectWaitSnapshot(session)).jobs[0].epochToken).toBe(waitEpochToken('epoch-H'));
  });

  it('carries a silent fault-page advance in a cursor frame and emits no message for it', async () => {
    const events = await collectWithFrames(
      readWaitSession({
        request: { jobIds: ['a'], timeoutSeconds: 0, cursor: savedCursor({ a: 5 }) },
        time: new VirtualTime(),
        read: () => [admitted('a', [], false)],
        visit: (_epoch, read) => ({
          kind: 'read',
          value: read({
            after: (_id, after, rows) =>
              progressPage(
                [51, 52, 53].filter((seq) => seq > after).map((seq) => ({ seq })),
                rows,
                53,
              ),
            before: (_id, _before, rows) => progressTail([], rows, 53),
          }),
        }),
      }),
    );
    expect(events.filter((event) => event.type === 'progress')).toEqual([]);
    const frames = events.filter((event) => event.type === 'cursor');
    expect(frames[0]).toMatchObject({ cursor: savedCursor({ a: 5 }) });
    expect(frames.at(-1)).toMatchObject({ cursor: savedCursor({ a: 53 }) });
  });
});

describe('only admitted members hold a bounded wait open (K3)', () => {
  it('keeps monitoring a running job when a sibling id is refused', async () => {
    const time = new VirtualTime();
    const events: WaitStreamEvent[] = [];
    let done = false;
    void (async () => {
      for await (const event of readWaitSession({
        request: { jobIds: ['a', 'ghost'], timeoutSeconds: 60 },
        time,
        read: observeWaitRead(() => [admitted('a', [], false), { jobId: 'ghost', disposition: 'missing' }]),
        visit: testProgressVisit,
        observe: (session) => session.observeCoverage(['a'], [], 1),
      }))
        events.push(event);
      done = true;
    })();
    await flushMicrotasks(50);
    expect(done).toBe(false);
    expect(events.some((event) => event.type === 'disposition' && event.jobId === 'ghost')).toBe(true);
  });
});

it('drains an internal backlog page by page, never a whole history in one synchronous pass', async () => {
  const job = admitted(
    'a',
    Array.from({ length: 1200 }, (_, index) => [index + 1, `line ${index}`]),
  );
  const observed = progressVisitFromEvents(() => job.detail.events);
  let rows = 0;
  let largestVisit = 0;
  const visit: ProgressVisit = (epoch, read) => {
    rows = 0;
    const result = observed(epoch, (source) =>
      read({
        after: (id, after, count) => {
          const page = source.after(id, after, count);
          rows += page.rows.length;
          return page;
        },
        before: (id, before, count) => source.before(id, before, count),
      }),
    );
    largestVisit = Math.max(largestVisit, rows);
    return result;
  };
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['a'], timeoutSeconds: 0 },
      internal: true,
      time: new VirtualTime(),
      read: () => [job],
      visit,
    }),
  );
  expect(events.filter((event) => event.type === 'progress')).toHaveLength(1200);
  expect(events.at(-1)?.type).toBe('terminal');
  expect(largestVisit).toBeLessThanOrEqual(501);
});

describe('every poll reads within one raw-row allowance (F1)', () => {
  const timing = { origin: 'runtime' as const, originAt: '', emittedAt: '', elapsedMs: 0 };
  type Raw = { seq: number; progress?: { seq: number; message: string; timing: typeof timing } };
  const message = (seq: number, text: string): Raw => ({ seq, progress: { seq, message: text, timing } });
  const faults = (from: number, count: number): Raw[] => Array.from({ length: count }, (_, i) => ({ seq: from + i }));
  const above = (raw: readonly Raw[], seq: number): number => {
    let low = 0;
    let high = raw.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (raw[middle].seq > seq) high = middle;
      else low = middle + 1;
    }
    return low;
  };
  /** Records the raw rows each poll reads, and whether a macrotask ran since the previous poll. */
  function rowSource(rows: Record<string, readonly Raw[]>, frontier: number) {
    const polls: { rows: number; afterMacrotask: boolean }[] = [];
    let macrotask = false;
    const visit: ProgressVisit = (_epoch, read) => {
      const poll = { rows: 0, afterMacrotask: macrotask };
      polls.push(poll);
      macrotask = false;
      setImmediate(() => {
        macrotask = true;
      });
      return {
        kind: 'read',
        value: read({
          after: (id, after, count) => {
            const start = above(rows[id], after);
            const raw = rows[id].slice(start, start + count + 1);
            poll.rows += raw.length;
            return progressPage(raw, count, frontier);
          },
          before: (id, before, count) => {
            const end = before === null ? rows[id].length : above(rows[id], before - 1);
            const raw = rows[id].slice(Math.max(0, end - count - 1), end).reverse();
            poll.rows += raw.length;
            return progressTail(raw, count, frontier);
          },
        }),
      };
    };
    return { visit, polls };
  }
  const steppedTime = (): TimePort => {
    let mono = 0n;
    return {
      ...virtualTimeMethods(),
      monotonicNow: () => mono,
      sleep: async (ms) => {
        mono += BigInt(ms);
      },
    };
  };

  it('delivers first within 500 raw rows over 100,000 fault rows and yields a macrotask between slices', async () => {
    const { visit, polls } = rowSource({ a: faults(1, 100_000) }, 100_001);
    const stream = readWaitSession({
      request: { jobIds: ['a'], timeoutSeconds: 0, cursor: savedCursor({ a: 0 }, 'E') },
      internal: true,
      time: new VirtualTime(),
      read: () => [admitted('a', [], true, 'E')],
      visit,
    });
    const first = await stream.next();
    expect(first.value).toMatchObject({ type: 'cursor' });
    expect(polls).toHaveLength(1);
    expect(polls[0].rows).toBeLessThanOrEqual(500);
    const events = [first.value as WaitStreamEvent, ...(await collectWithFrames(stream))];
    expect(polls.length).toBeGreaterThanOrEqual(200);
    expect(polls.every((poll) => poll.rows <= 500)).toBe(true);
    expect(polls.slice(1).every((poll) => poll.afterMacrotask)).toBe(true);
    expect(events.filter((event) => event.type === 'progress')).toEqual([]);
    const frames = events.filter((event) => event.type === 'cursor');
    expect(frames.at(-1)).toMatchObject({ cursor: savedCursor({ a: 100_001 }, 'E') });
    expect(events.at(-1)).toMatchObject({ type: 'terminal', jobId: 'a' });
  });

  it('positions a cursorless tail over a fault-dense history in bounded slices and lands on the true tail', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => message(i + 1, `line-${i + 1}`));
    const { visit, polls } = rowSource({ a: [...lines, ...faults(41, 30_000)] }, 30_040);
    const events = await collectWithFrames(
      readWaitSession({
        request: { jobIds: ['a'], timeoutSeconds: 60 },
        time: steppedTime(),
        read: () => [admitted('a', [], true, 'E')],
        visit,
      }),
    );
    expect(events.filter((event) => event.type === 'progress').map((event) => event.message)).toEqual(
      Array.from({ length: 20 }, (_, i) => `line-${i + 21}`),
    );
    expect(events).toContainEqual({
      type: 'notice',
      message: 'Earlier progress for a was not shown; showing the most recent lines.',
    });
    expect(events.at(-1)).toMatchObject({ type: 'terminal', jobId: 'a', remainingJobIds: [] });
    expect(polls.length).toBeGreaterThan(60);
    expect(polls.every((poll) => poll.rows <= 500)).toBe(true);
  });

  it('delivers every line exactly once when a stream is cut at any event across slices', async () => {
    const history: Record<string, Raw[]> = {
      a: [0, 1, 2, 3, 4].flatMap((i) => [
        message(1 + i * 701, i === 2 ? 'a-2a\na-2b' : `a-${i}`),
        ...faults(2 + i * 701, 700),
      ]),
      b: [0, 1, 2].flatMap((i) => [message(4000 + i * 1201, `b-${i}`), ...faults(4001 + i * 1201, 1200)]),
      c: [...faults(8000, 1500), ...[0, 1, 2, 3, 4].map((i) => message(9500 + i, `c-${i}`)), ...faults(9505, 900)],
    };
    const expected = {
      a: ['a-0', 'a-1', 'a-2a', 'a-2b', 'a-3', 'a-4'],
      b: ['b-0', 'b-1', 'b-2'],
      c: ['c-0', 'c-1', 'c-2', 'c-3', 'c-4'],
    };
    const jobs = [admitted('a', [], true, 'E1'), admitted('b', [], true, 'E1'), admitted('c', [], true, 'E2')];
    const run = async (cut: number) => {
      const { visit } = rowSource(history, 10_405);
      let cursor: WaitCursor | undefined = savedCursor({ a: 0, b: 0 }, 'E1');
      let ids = ['a', 'b', 'c'];
      let events = 0;
      const printed: Record<string, string[]> = { a: [], b: [], c: [] };
      const fold = (event: WaitStreamEvent) => {
        const decision = advanceWaitRenderCursor(cursor, event);
        cursor = decision.cursor;
        if (event.type === 'progress' && decision.shouldRender) printed[event.jobId].push(...event.message.split('\n'));
        if (isFinalWaitEvent(event)) ids = event.type === 'waiting' ? event.waitingJobIds : event.remainingJobIds;
      };
      const stream = () =>
        readWaitSession({
          request: { jobIds: ids, timeoutSeconds: 60, ...(cursor ? { cursor } : {}) },
          time: steppedTime(),
          read: () => jobs.filter((job) => ids.includes(job.jobId)),
          visit,
        });
      const first = stream();
      for (let index = 0; index < cut; index++) {
        const next = await first.next();
        if (next.done) break;
        events++;
        fold(next.value);
      }
      await first.return(undefined);
      for (let requests = 0; ids.length && requests < 12; requests++) for await (const event of stream()) fold(event);
      return { printed, ids, events };
    };
    const uncut = await run(Infinity);
    expect(uncut.printed).toEqual(expected);
    expect(uncut.ids).toEqual([]);
    for (let cut = 0; cut <= uncut.events; cut++) {
      const result = await run(cut);
      expect({ cut, printed: result.printed, ids: result.ids }).toEqual({ cut, printed: expected, ids: [] });
    }
  });
});

it('opens a continuation from a positioned cursor with a frame, so a fold that starts from no cursor has a base', async () => {
  let client: WaitCursor | undefined;
  const types: string[] = [];
  for await (const event of readWaitSession({
    request: { jobIds: ['j'], cursor: savedCursor({ j: 0 }, 'E'), timeoutSeconds: 1, drainProgress: true },
    time: new VirtualTime(),
    read: observeWaitRead(() => [
      admitted(
        'j',
        [
          [1, 'one'],
          [2, 'two'],
        ],
        false,
        'E',
      ),
    ]),
    visit: testProgressVisit,
  })) {
    types.push(event.type);
    client = advanceWaitRenderCursor(client, event).cursor;
    if (event.type === 'progress') break;
  }
  expect(types).toEqual(['cursor', 'progress']);
  expect(client).toEqual(savedCursor({ j: 1 }, 'E'));
});
