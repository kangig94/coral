import { createHttpHandler } from '#src/transport/http/handler.js';
import { createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import { getEventListeners } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import assert from 'node:assert/strict';
const count = Number(process.argv[2] ?? 10000);
const supportsHandover = process.argv[3] !== 'legacy';
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
    token: 'test-http',
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
    validateWait: () => null,
    waitHandoverSignal: () => handover.signal,
    async *waitStream(req) {
      req.abortSignal.addEventListener('abort', release, { once: true });
      for (let i = 0; i < count; i++) {
        const event = { type: 'progress', jobId: 'job-1', seq: i + 1, message: 'event-' + i, timing };
        weak.push(new WeakRef(event));
        yield event;
        if (i % 16 === 0) await tick();
      }
      await streamHold;
    },
  },
};

const server = createServer((req, res) => {
  void createHttpHandler(ports)(req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let frames = 0,
  pending = '',
  resolveConsumed;
const consumed = new Promise((r) => (resolveConsumed = r));
const client = request(
  {
    hostname: '127.0.0.1',
    port: server.address().port,
    path: '/jobs/wait',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Coral-Backend-Token': 'test-http' },
  },
  (res) => {
    res.on('data', (chunk) => {
      pending += chunk.toString();
      let end;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        pending = pending.slice(end + 2);
        if (++frames === count) resolveConsumed();
      }
    });
  },
);
client.end(JSON.stringify({ jobIds: ['job-1'], projectRoot: '/tmp', timeoutSeconds: 600 }));
await consumed;
for (let i = 0; i < 4; i++) {
  await tick();
  global.gc();
}
const retained = weak.reduce((n, r) => n + Number(r.deref() !== undefined), 0);
console.log(JSON.stringify({ count, frames, retainedConsumedEvents: retained }));
client.destroy();
release();
server.closeAllConnections();
await new Promise((r) => server.close(r));
for (let i = 0; i < 4; i++) {
  await tick();
  global.gc();
}
console.log(
  JSON.stringify({ afterCloseRetainedEvents: weak.reduce((n, r) => n + Number(r.deref() !== undefined), 0) }),
);
assert.ok(retained <= 2, 'HTTP jobs.wait retained ' + retained + ' consumed events');
