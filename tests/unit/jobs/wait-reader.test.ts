import { expect, it } from 'vitest';
import { readWaitSession } from '#src/jobs/wait/reader.js';
import { WaitSession, type WaitAdmission } from '#src/jobs/wait/session.js';
import { selectWaitSnapshot } from '#src/jobs/wait/snapshot.js';
import { createRealTimePort } from '#src/infra/time.js';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';
import { admitted } from '#tests/helpers/wait-session.js';
import type { WaitStreamEvent, WaitCursorV3 } from '#src/jobs/wait/contract.js';

async function collect(stream: AsyncGenerator<WaitStreamEvent>): Promise<WaitStreamEvent[]> {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

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
