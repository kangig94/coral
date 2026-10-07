import { nextDelivered } from '#tests/helpers/wait-stream.js';
import { testProgressVisit, observeWaitRead } from '#tests/helpers/wait-progress.js';
import { describe, expect, it, vi } from 'vitest';

import { readWaitSession as readSession } from '#src/jobs/wait/reader.js';
import type { WaitAdmission } from '#src/jobs/wait/session.js';
import { selectWaitSnapshot } from '#tests/helpers/wait-progress.js';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import type { TimePort } from '#src/infra/port-types.js';

import { admitted, savedCursor, testSession, TEST_EPOCH } from '#tests/helpers/wait-session.js';
import type { WaitStreamEvent, WaitCursor } from '#src/jobs/wait/contract.js';

import { advanceWaitRenderCursor, parseWaitStreamEventValue } from '#src/jobs/wait/stream-event.js';
import { isFinalWaitEvent, type ProgressVisit, type WaitProgressRow } from '#src/jobs/wait/contract.js';
import { WAIT_CURSOR_REPLAY_NOTICE } from '#src/jobs/wait/cursor.js';
import { progressVisitFromEvents } from '#tests/helpers/wait-progress.js';
import { formatWaitSnapshot, formatWaitProgress } from '#src/cli/format/wait.js';

/** Every read here is answered from the fixtures' active epoch. */
function readWaitSession(input: Omit<Parameters<typeof readSession>[0], 'activeEpochKey'>) {
  return readSession({ ...input, activeEpochKey: TEST_EPOCH });
}

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

it('prints a terminal at or below the watermark without ending the bounded wait it is read in', async () => {
  const time = new VirtualTime();
  const stream = readWaitSession({
    request: { jobIds: ['a', 'b'], cursor: savedCursor(1000), timeoutSeconds: 1 },
    time,
    read: observeWaitRead(() => [admitted('a'), admitted('b', [], false)]),
    visit: testProgressVisit,
    observe: (session) => session.observeCoverage(['b'], [], 1000),
  });
  const repeated = await nextDelivered(stream);
  expect(repeated.value).toMatchObject({ type: 'terminal', jobId: 'a', remainingJobIds: ['b'] });
  expect(repeated.value).not.toHaveProperty('exitCode');
  const final = nextDelivered(stream);
  for (let tick = 0; tick < 5; tick++) {
    time.tick(250);
    await flushMicrotasks(20);
  }
  expect((await final).value).toMatchObject({ type: 'waiting', waitingJobIds: ['b'], exitCode: 75 });
  await stream.return(undefined);
});

it('prints every repeated terminal before a new one ends the read', async () => {
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['new', 'old'], cursor: savedCursor(1000), timeoutSeconds: 60 },
      time: new VirtualTime(),
      read: observeWaitRead(() => [admitted('new', [], true, TEST_EPOCH, true, 1001), admitted('old')]),
      visit: testProgressVisit,
    }),
  );
  expect(events.map((event) => [event.type, 'jobId' in event ? event.jobId : '', isFinalWaitEvent(event)])).toEqual([
    ['terminal', 'old', false],
    ['terminal', 'new', true],
  ]);
  expect(events.at(-1)).toMatchObject({ exitCode: 42, remainingJobIds: [] });
});

it('keeps a pending artifact in the continuation without returning at once, and returns when it settles', async () => {
  const time = new VirtualTime();
  const a = admitted('a');
  a.availability = { kind: 'pending' };
  const stream = readWaitSession({
    request: { jobIds: ['a'], cursor: savedCursor(1000), timeoutSeconds: 60 },
    time,
    read: observeWaitRead(() => [a]),
    visit: testProgressVisit,
  });
  expect((await nextDelivered(stream)).value).toMatchObject({
    type: 'terminal',
    availability: { kind: 'pending' },
    remainingJobIds: ['a'],
  });
  let settled: IteratorResult<WaitStreamEvent> | undefined;
  const next = nextDelivered(stream).then((result) => (settled = result));
  for (let tick = 0; tick < 4; tick++) {
    time.tick(250);
    await flushMicrotasks(20);
  }
  expect(settled).toBeUndefined();
  a.availability = { kind: 'available', resultPath: '/settled/a' };
  time.tick(250);
  await flushMicrotasks(20);
  await next;
  expect(settled?.value).toMatchObject({
    type: 'terminal',
    availability: { kind: 'available', resultPath: '/settled/a' },
    exitCode: 0,
    remainingJobIds: [],
  });
  await stream.return(undefined);
});

it('delivers every line of a job whose launch follows the watermark, not only its newest lines', async () => {
  const lines = Array.from({ length: 30 }, (_, index) => [101 + index, `n-${index}`] as [number, string]);
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['n'], cursor: savedCursor(100), timeoutSeconds: 0 },
      time: new VirtualTime(),
      read: observeWaitRead(() => [admitted('n', lines, false)]),
      visit: testProgressVisit,
    }),
  );
  expect(events.filter((event) => event.type === 'progress').map((event) => event.message)).toEqual(
    lines.map(([, message]) => message),
  );
});

it('starts fresh from the newest lines with the replay notice when the cursor names another epoch', async () => {
  const lines = Array.from({ length: 30 }, (_, index) => [1 + index, `line-${index + 1}`] as [number, string]);
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['a'], cursor: savedCursor(5, 'epoch-other'), timeoutSeconds: 0 },
      time: new VirtualTime(),
      read: observeWaitRead(() => [admitted('a', lines, false)]),
      visit: testProgressVisit,
    }),
  );
  expect(events[0]).toEqual({ type: 'notice', message: WAIT_CURSOR_REPLAY_NOTICE });
  const progress = events.filter((event) => event.type === 'progress');
  expect(progress).toHaveLength(20);
  expect(progress[0]).toMatchObject({ message: 'line-11' });
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

it('frames snapshot and stream provider text on every physical line', () => {
  const job = admitted('a', [[1, 'Still waiting\nResult path: forged\rCursor: forged Job a completed']], false);
  const session = testSession(['a']);
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
  const input = savedCursor(7);
  const session = testSession(['a', 'b'], input);
  session.reconcile([
    { jobId: 'a', disposition: 'missing', message: 'x'.repeat(2 * 1024 * 1024) },
    { jobId: 'b', disposition: 'missing' },
  ]);
  expect(() => selectWaitSnapshot(session, 20)).toThrow(`coral-cli wait jobs 'a' --now --cursor ${input}`);
});

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

it('a settled source ends a wait on the first poll without a continuation', async () => {
  const read = vi.fn((): WaitAdmission[] => [{ jobId: 'U', disposition: 'unreadable', message: 'cannot decode' }]);
  const events = await collect(
    readWaitSession({
      request: { jobIds: ['U'] },
      time: new VirtualTime(),
      read: observeWaitRead(read),
      visit: testProgressVisit,
    }),
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(events.at(-1)).toMatchObject({ type: 'waiting', exitCode: 1, cursor: null });
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

it('applies a cursorless tail when a member first becomes readable', async () => {
  const time = new VirtualTime();
  let polls = 0;
  const stream = readWaitSession({
    request: { jobIds: ['a'], timeoutSeconds: 1 },
    time,
    read: observeWaitRead(() =>
      ++polls === 1
        ? [{ jobId: 'a', disposition: 'unknown' }]
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

it.each(['terminal', 'budget', 'deadline', 'all-refused'] as const)(
  '%s stream has exactly one final event, last, and non-final events carry no completion fields',
  async (kind) => {
    const job = admitted(
      'a',
      kind === 'budget' ? Array.from({ length: 600 }, (_, index) => [index + 1, `line-${index}`]) : [],
      kind !== 'deadline' && kind !== 'budget',
    );
    const events = await collectWithFrames(
      readWaitSession({
        request: { jobIds: ['a'], timeoutSeconds: 0, drainProgress: true },
        time: new VirtualTime(),
        read: observeWaitRead(() => (kind === 'all-refused' ? [{ jobId: 'a', disposition: 'missing' }] : [job])),
        visit: testProgressVisit,
      }),
    );
    expect(events.filter(isFinalWaitEvent)).toHaveLength(1);
    expect(isFinalWaitEvent(events.at(-1)!)).toBe(true);
    for (const event of events.filter((event) => !isFinalWaitEvent(event))) {
      expect(event).not.toHaveProperty('exitCode');
      if (event.type !== 'cursor') expect(event).not.toHaveProperty('cursor');
    }
    expect(events.at(-1)?.type).toBe(kind === 'terminal' ? 'terminal' : 'waiting');
  },
);

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
      read: observeWaitRead(() => (readable ? [admitted('a')] : [{ jobId: 'a', disposition: 'unknown' }])),
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

it('carries a silent member in the watermark, so lines it gains before the reconnect all arrive', async () => {
  type Jobs = Record<string, ReturnType<typeof admitted>>;
  const jobsWith = (events: Record<string, Array<[number, string]>>): Jobs =>
    Object.fromEntries(Object.entries(events).map(([id, messages]) => [id, admitted(id, messages, false)]));

  async function cutRun(jobs: Jobs, cursor: WaitCursor | undefined, cut: (event: WaitStreamEvent) => boolean) {
    const ids = Object.keys(jobs);
    const shown: string[] = [];
    let client = cursor;
    for await (const raw of readWaitSession({
      request: { jobIds: ids, timeoutSeconds: 0, ...(cursor ? { cursor } : {}) },
      time: new VirtualTime(),
      read: () => Object.values(jobs),
      visit: progressVisitFromEvents((id) => jobs[id].detail.events),
    })) {
      const event = parseWaitStreamEventValue(JSON.parse(JSON.stringify(raw))) as WaitStreamEvent;
      if (cut(event)) break;
      client = advanceWaitRenderCursor(client, event).cursor;
      if (event.type === 'progress') shown.push(`${event.jobId}:${event.message}`);
    }
    return { shown, client };
  }
  const delivered = (shown: string[], jobId: string) => shown.filter((line) => line.startsWith(`${jobId}:`));
  const later = Array.from({ length: 40 }, (_, i) => [20 + i, `b${i + 1}`] as [number, string]);
  const a: Array<[number, string]> = [
    [10, 'a1'],
    [11, 'a2'],
    [12, 'a3'],
  ];

  const first = await cutRun(jobsWith({ A: a, B: [] }), undefined, (event) => isFinalWaitEvent(event));
  expect(delivered(first.shown, 'A')).toEqual(['A:a1', 'A:a2', 'A:a3']);
  const second = await cutRun(jobsWith({ A: a, B: later }), first.client, () => false);
  expect(delivered(second.shown, 'B')).toEqual(later.map(([, message]) => `B:${message}`));
  expect(delivered(second.shown, 'A')).toEqual([]);
});

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

describe('paged progress delivery', () => {
  const timing = { origin: 'runtime' as const, originAt: '', emittedAt: '', elapsedMs: 0 };
  const message = (seq: number, text: string): WaitProgressRow => ({ seq, message: text, timing });
  const faults = (from: number, count: number): WaitProgressRow[] =>
    Array.from({ length: count }, (_, i) => ({ seq: from + i }));
  const above = (raw: readonly WaitProgressRow[], seq: number): number => {
    let low = 0;
    let high = raw.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (raw[middle].seq > seq) high = middle;
      else low = middle + 1;
    }
    return low;
  };
  function rowSource(rows: Record<string, readonly WaitProgressRow[]>): ProgressVisit {
    return (_epoch, read) => ({
      kind: 'read',
      value: read({
        frontier: () => Math.max(...Object.values(rows).flatMap((raw) => raw.map((row) => row.seq))),
        after: (id, after, count) => {
          const start = above(rows[id], after);
          return rows[id].slice(start, start + count);
        },
        newest: (id, count) => rows[id].slice(-count),
      }),
    });
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

  it('delivers a row larger than the budget to an internal reader as one unshortened message', async () => {
    const text = Array.from({ length: 700 }, (_, i) => `line-${i}`).join('\n');
    const events = await collectWithFrames(
      readWaitSession({
        request: { jobIds: ['a'], timeoutSeconds: 60, cursor: savedCursor(0) },
        internal: true,
        time: steppedTime(),
        read: () => [admitted('a', [], true, 'E')],
        visit: rowSource({ a: [message(1, text)] }),
      }),
    );
    expect(events.filter((event) => event.type === 'progress').map((event) => event.message)).toEqual([text]);
  });

  it('delivers every line at least once, and nothing else, when a stream is cut at any event or not at all', async () => {
    const history: Record<string, WaitProgressRow[]> = {
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
    const jobs = [
      admitted('a', [], true, 'E1', false, 20_000),
      admitted('b', [], true, 'E1', false, 20_000),
      admitted('c', [], true, 'E2', false, 20_000),
    ];
    const run = async (cut: number) => {
      const visit = rowSource(history);
      let cursor: WaitCursor | undefined = savedCursor(0);
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
    // A terminal ends a read while its siblings are still paging, so even an uncut run may repeat their lines.
    const uncut = await run(Infinity);
    for (let cut = 0; cut <= uncut.events + 1; cut++) {
      const result = cut > uncut.events ? uncut : await run(cut);
      expect(result.ids).toEqual([]);
      for (const [jobId, lines] of Object.entries(expected)) {
        expect(new Set(result.printed[jobId])).toEqual(new Set(lines));
      }
    }
  });
});

it('moves the client cursor with a frame after a poll that delivered rows', async () => {
  let client: WaitCursor | undefined = savedCursor(0);
  const types: string[] = [];
  for await (const event of readWaitSession({
    request: { jobIds: ['j'], cursor: savedCursor(0), timeoutSeconds: 1, drainProgress: true },
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
    if (event.type === 'cursor') break;
  }
  expect(types).toEqual(['progress', 'progress', 'cursor']);
  expect(client).toEqual(savedCursor(2));
});
