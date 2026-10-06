import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { createHttpHandler } from '#src/transport/http/handler.js';
import { createIpcServer, closeIpcServer } from '#src/transport/ipc/server.js';
import { decodeWaitCursor, waitEpochToken, waitJobHash } from '#src/jobs/wait/cursor.js';
import { serializeWaitCursor, waitCursorForJobs } from '#src/jobs/wait/cursor.js';
import { formatWaitWaiting } from '#src/cli/format/wait.js';
import { WaitSession } from '#src/jobs/wait/session.js';
import { progressPage, progressTail } from '#src/jobs/wait/progress-page.js';
import { WaitCoordinator } from '#src/jobs/shell/wait.js';
import { VirtualTime, flushMicrotasks } from '#tools/simulation/core/virtual-time.js';

const [transport, scenario] = process.argv.slice(2);
if (scenario === 'observer') {
  const time = new VirtualTime();
  const stuck = new Promise(() => {});
  const wait = new WaitCoordinator({
    time,
    eventBus: { on() {}, off() {} },
    sessionManager: { get: () => null },
    launchQueue: { reservationFor: () => null, getActiveJobIds: () => [] },
    loadJobWaitDetail: () => ({ status: { jobId: 'known', phase: 'running' }, runtime: null, exit: null }),
    readJobLastSeq: () => null,
    visitProgress: (_epoch, read) => ({kind: 'read', value: read({after: () => progressPage([], 500, 0), before: () => progressTail([], 20, 0)})}),
    aggregateWorkflowUsage: () => undefined,
    getCurrentJournalSeq: () => 0,
    resultJobsRoot: '/unused',
    subscribeJobEvents: () => ({ [Symbol.asyncIterator]: () => ({ next: () => stuck, return: () => stuck }) }),
    observeCarriers: () => stuck,
  });
  const stream = wait.waitForOutcomes({ jobIds: ['known'], timeoutSeconds: 1 });
  const nextFinal = async () => {
    for (;;) {
      const next = await stream.next();
      if (next.done || ['terminal', 'artifact', 'waiting'].includes(next.value.type)) return next;
    }
  };
  const first = nextFinal();
  let settled = false;
  void first.then(() => {
    settled = true;
  });
  await flushMicrotasks(20);
  time.tick(1_000);
  await flushMicrotasks(50);
  assert.ok(settled, 'carrier observer exceeded the stream deadline');
  const next = await first;
  assert.deepEqual(next.value.carrierUnknownJobIds, ['known']);
  await stream.return();
  process.exit(0);
}
if (scenario === 'codec') {
  assert.equal(decodeWaitCursor({ version: 'jobs.wait.future', afterSeq: 42 }).kind, 'rejected');
  process.exit(0);
}
const handover = new AbortController();
let release;
const hold = new Promise((resolve) => {
  release = resolve;
});
const noOp = () => {};
const stub = new Proxy({}, { get: () => noOp });
const entry = (jobId) => ({ hash: waitJobHash(jobId), epoch: waitEpochToken('epoch'), seq: 42, lineOffset: 0, flags: 0 });
const cursor = { jobs: [entry('known'), entry('ghost')] };
const ports = {
  identity: {
    pluginRoot: process.env.HOME,
    token: 'test',
    bootToken: 'boot',
    namespace: 'probe',
    instanceId: 'probe',
    log: console.error,
    now: Date.now,
  },
  admin: {
    isLifecycleRunning: () => true,
    isDrainRequested: () => false,
    isLaunchFenceActive: () => false,
    beginRequest: noOp,
    endRequest: noOp,
  },
  coralEnvSnapshot: {},
  systemProviderScope: {},
  sessions: stub,
  workflows: stub,
  kb: stub,
  discuss: stub,
  events: stub,
  expansion: stub,
  recoveryQuarantine: stub,
  jobs: {
    unknownJobDisposition: () => 'not-found',
    admitWait: (req) => req.jobIds.map((jobId) => ({ jobId, epochKey: 'epoch', disposition: scenario === 'missing' && jobId === 'ghost' ? 'missing' : 'admitted' })),
    validateWait: () => null,
    scopeCheck: () => ({ valid: ['known'], missing: scenario === 'missing' ? ['ghost'] : [], mismatch: [] }),
    waitHandoverSignal: () => handover.signal,
    async *waitStream(req) {
      req.abortSignal.addEventListener('abort', release, { once: true });
      if (scenario !== 'missing') {
        yield {
          type: 'progress',
          jobId: 'known',
          seq: 43,
          message: 'progress',
          timing: {
            origin: 'runtime',
            originAt: '2026-10-04T00:00:00Z',
            emittedAt: '2026-10-04T00:00:00Z',
            elapsedMs: 0,
          },
          entry: { ...entry('known'), seq: 43 },
        };
        await hold;
      }
      const session = new WaitSession(req.jobIds, req.cursor);
      session.reconcile(req.admissions);
      const remaining = session.remaining();
      yield {
        type: 'waiting',
        waitingJobIds: remaining,
        cursor: waitCursorForJobs(req.cursor ?? cursor, remaining),
        exitCode: session.exitCode(),
      };
    },
  },
};
const params = {
  jobIds: scenario === 'missing' ? ['known', 'ghost'] : ['known'],
  projectRoot: process.env.HOME,
  timeoutSeconds: 10,
};
const events = [];
function received(event) {
  events.push(event);
  if (event.type === 'progress') {
    // The handover listener runs inside abort(); the next macrotask then releases a stream no handover ended.
    handover.abort();
    setImmediate(release);
  }
}

if (transport === 'http') {
  const handler = createHttpHandler(ports);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await new Promise((resolve, reject) => {
      const client = request(
        {
          hostname: '127.0.0.1',
          port: server.address().port,
          path: '/jobs/wait',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Coral-Backend-Token': 'test',
            ...(scenario === 'missing' ? { 'Last-Event-ID': serializeWaitCursor(cursor) } : {}),
            ...(scenario === 'unknown-header'
              ? {
                  'Last-Event-ID': Buffer.from(JSON.stringify({ version: 'jobs.wait.future', afterSeq: 42 })).toString(
                    'base64url',
                  ),
                }
              : {}),
          },
        },
        (res) => {
          let pending = '';
          res.on('data', (chunk) => {
            pending += chunk.toString();
            let end;
            while ((end = pending.indexOf('\n\n')) >= 0) {
              const frame = pending.slice(0, end);
              pending = pending.slice(end + 2);
              const data = frame.split('\n').find((line) => line.startsWith('data:'));
              if (data) received(JSON.parse(data.slice(5)));
            }
          });
          res.on('end', () => {
            if (scenario === 'unknown-header') {
              assert.equal(res.statusCode, 400);
              assert.equal(JSON.parse(pending).code, 'wait_cursor_malformed');
            } else assert.equal(pending, '');
            resolve();
          });
          res.on('error', reject);
        },
      );
      client.on('error', reject);
      client.end(JSON.stringify(params));
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
} else {
  const listener = createIpcServer(ports);
  const address = join(process.env.HOME, 'wait.sock');
  await new Promise((resolve) => listener.server.listen(address, resolve));
  try {
    await new Promise((resolve, reject) => {
      const client = createConnection(address);
      let pending = '';
      client.on('data', (chunk) => {
        pending += chunk.toString();
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const frame = JSON.parse(pending.slice(0, end));
          pending = pending.slice(end + 1);
          if (frame.kind === 'error') assert.fail(`wait stream refused: ${JSON.stringify(frame.error)}`);
          if (frame.kind === 'notification') received(frame.params);
        }
      });
      client.on('error', reject);
      client.on('end', resolve);
      client.write(
        JSON.stringify({
          kind: 'request',
          id: 1,
          method: 'jobs.wait',
          auth: { kind: 'boot', token: 'boot' },
          params: { ...params, cursor: scenario === 'missing' ? cursor : { jobs: [] } },
        }) + '\n',
      );
    });
  } finally {
    await closeIpcServer(listener);
  }
}

if (scenario === 'missing') {
  const waiting = events.find((event) => event.type === 'waiting');
  assert.deepEqual(waiting.waitingJobIds, ['known']);
  assert.deepEqual(
    waiting.cursor.jobs.map((job) => job.hash),
    [waitJobHash('known')],
  );
  assert.equal(formatWaitWaiting(waiting, serializeWaitCursor(waiting.cursor)).includes('ghost'), false);
} else if (scenario !== 'unknown-header') {
  assert.equal(
    events.some((event) => event.type === 'handover'),
    true,
    'every wait stream carries the handover notice',
  );
  assert.equal(events.filter((event) => event.type === 'progress').length, 1);
}
console.log(JSON.stringify({ transport, scenario, events }));
