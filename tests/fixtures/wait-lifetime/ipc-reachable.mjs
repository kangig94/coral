import { createIpcServer, closeIpcServer } from '#src/transport/ipc/server.js';
import { createConnection } from 'node:net';
import { setImmediate as tick } from 'node:timers/promises';
import assert from 'node:assert/strict';
const count = Number(process.argv[2] ?? 10000);
const weak = [];
let release;
const streamHold = new Promise((r) => (release = r));
const noOp = () => {};
const stub = new Proxy({}, { get: () => noOp });
const handover = new AbortController();
const timing = { origin: 'runtime', originAt: '2026-10-03T00:00:00Z', emittedAt: '2026-10-03T00:00:00Z', elapsedMs: 0 };
const ports = {
  identity: {
    pluginRoot: '/tmp',
    bootToken: 'test-boot',
    namespace: 'probe',
    instanceId: 'probe',
    log: console.error,
    now: () => Date.now(),
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
    outcomeUnrecoverable: () => [],
    unknownJobDisposition: () => 'not-found',
    scopeCheck: () => ({ valid: ['job-1'], missing: [], mismatch: [] }),
    admitWait: (req) => req.jobIds.map((jobId) => ({ jobId, disposition: 'admitted' })),
    validateWait: () => null,
    waitHandoverSignal: () => handover.signal,
    async *waitStream(req) {
      req.abortSignal.addEventListener('abort', release, { once: true });
      for (let i = 0; i < count; i++) {
        const event = { type: 'progress', jobId: 'job-1', seq: i + 1, message: 'event-' + i, timing };
        weak.push(new WeakRef(event));
        yield event;
      }
      await streamHold;
    },
  },
};
const listener = createIpcServer(ports);
const address = '/tmp/reachable-' + process.pid + '.sock';
await new Promise((r) => listener.server.listen(address, r));
const client = createConnection(address);
let frames = 0;
let pending = '';
let resolveConsumed;
const consumed = new Promise((r) => (resolveConsumed = r));
client.on('data', (chunk) => {
  pending += chunk.toString();
  let nl;
  while ((nl = pending.indexOf('\n')) >= 0) {
    const frame = pending.slice(0, nl);
    pending = pending.slice(nl + 1);
    const parsed = JSON.parse(frame);
    if (parsed.kind === 'error') console.error(parsed);
    frames++;
    if (frames === count + 1) resolveConsumed();
  }
});
client.write(
  JSON.stringify({
    kind: 'request',
    id: 1,
    method: 'jobs.wait',
    auth: { kind: 'boot', token: 'test-boot' },
    params: {
      jobIds: ['job-1'],
      projectRoot: '/tmp',
      timeoutSeconds: 600,
      cursor: null,
    },
  }) + '\n',
);
const timeout = setTimeout(() => {
  console.error('probe timed out: frames', frames);
  client.destroy();
  release();
}, 10000);
await consumed;
for (let i = 0; i < 4; i++) {
  await tick();
  global.gc();
}
const retained = weak.reduce((n, r) => n + Number(r.deref() !== undefined), 0);
console.log(
  JSON.stringify({
    count,
    frames,
    retainedConsumedEvents: retained,
    heapUsed: process.memoryUsage().heapUsed,
  }),
);
clearTimeout(timeout);
client.destroy();
release();
await closeIpcServer(listener);
for (let i = 0; i < 4; i++) {
  await tick();
  global.gc();
}
console.log(
  JSON.stringify({ afterCloseRetainedEvents: weak.reduce((n, r) => n + Number(r.deref() !== undefined), 0) }),
);
assert.ok(retained <= 2, 'Production jobs.wait retained ' + retained + ' consumed events');
