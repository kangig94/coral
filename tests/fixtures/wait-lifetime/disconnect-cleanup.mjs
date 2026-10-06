import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { WaitCoordinator } from '#src/jobs/shell/wait.js';
import { withSuccessionHandover } from '#src/transport/dispatch.js';
import { streamSubscription } from '#src/transport/ipc/server.js';
const activeTimers = new Map();
const time = {
  now: () => 0,
  monotonicNow: () => 0,
  setTimeout(fn, ms) {
    const handle = {};
    activeTimers.set(handle, ms);
    return handle;
  },
  clearTimeout(handle) {
    activeTimers.delete(handle);
  },
};
const deps = {
  time,
  getCurrentJournalSeq: () => 0,
  loadJobWaitDetail: () => ({ status: null }),
  readJobLastSeq: () => null,
  launchQueue: {},
  async *subscribeJobEvents({ abortSignal }) {
    yield {
      type: 'progress',
      jobId: 'job-1',
      seq: 1,
      message: 'first',
      timing: { origin: 'runtime', originAt: '2026-10-03T00:00:00Z', emittedAt: '2026-10-03T00:00:00Z', elapsedMs: 0 },
    };
    await new Promise((r) => abortSignal.addEventListener('abort', r, { once: true }));
  },
};
class DisconnectOnWrite extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writes = 0;
  write(frame) {
    if (++this.writes === 1) return true;
    setImmediate(() => this.destroy());
    return false;
  }
  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
  end() {
    this.writableEnded = true;
  }
}
const controller = new AbortController();
const upstream = new WaitCoordinator(deps).waitForOutcomes({
  jobIds: ['job-1'],
  timeoutSeconds: 600,
  abortSignal: controller.signal,
});
const notifications = withSuccessionHandover(upstream, new AbortController().signal);
const socket = new DisconnectOnWrite();
await streamSubscription(
  socket,
  { kind: 'request', id: 1, method: 'jobs.wait' },
  { method: 'jobs.wait' },
  { kind: 'subscription', notifications },
  controller,
  { writeDrainTimeoutMs: 5000 },
  null,
);
await tick();
console.log(
  JSON.stringify({
    writes: socket.writes,
    clientDisconnected: socket.destroyed,
    requestAborted: controller.signal.aborted,
    leakedWaitTimeouts: [...activeTimers.values()],
  }),
);
assert.equal(activeTimers.size, 0, 'Backpressure followed by disconnect must clean up production wait timers');
