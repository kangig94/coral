import { afterEach, expect, it, vi } from 'vitest';
import { readWaitSession } from '#src/jobs/wait/reader.js';
import { WaitSession } from '#src/jobs/wait/session.js';
import { parseWaitSnapshot, selectWaitSnapshot } from '#src/jobs/wait/snapshot.js';
import { parseWaitStreamEventValue } from '#src/jobs/wait/stream-event.js';
import { serializeWaitCursor } from '#src/jobs/wait/cursor.js';
import { formatWaitSnapshot, formatWaitWaiting, formatWaitProgress, formatWaitTerminal } from '#src/cli/format/wait.js';
import { createRealTimePort } from '#src/infra/time.js';
import { admitted } from '#tests/helpers/wait-session.js';

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
