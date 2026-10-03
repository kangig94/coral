import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { WaitCoordinator } from '#src/jobs/shell/wait.js';
import { withSuccessionHandover } from '#src/transport/dispatch.js';
for (const modern of [false, true]) {
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
  let subscriptionClosed = false;
  const deps = {
    time,
    getCurrentJournalSeq: () => 0,
    readJobEvents: () => [],
    loadJobProjectionDetail: () => ({ status: null }),
    launchQueue: {},
    async *subscribeJobEvents({ abortSignal }) {
      try {
        yield {
          type: 'progress',
          jobId: 'job-1',
          seq: 1,
          message: 'progress',
          timing: {
            origin: 'runtime',
            originAt: '2026-10-03T00:00:00Z',
            emittedAt: '2026-10-03T00:00:00Z',
            elapsedMs: 0,
          },
        };
        await new Promise((r) => abortSignal.addEventListener('abort', r, { once: true }));
      } finally {
        subscriptionClosed = true;
      }
    },
  };
  const controller = new AbortController();
  const upstream = new WaitCoordinator(deps).waitForJobs({
    jobIds: ['job-1'],
    timeoutSeconds: 600,
    abortSignal: controller.signal,
  });
  const wrapped = withSuccessionHandover(upstream, modern ? new AbortController().signal : undefined);
  await wrapped.next();
  controller.abort();
  await wrapped.return();
  await tick();
  const result = { supportsHandover: modern, subscriptionClosed, activeWaitTimers: [...activeTimers.values()] };
  console.log(JSON.stringify(result));
  if (modern) assert.equal(activeTimers.size, 0, 'Disconnected current wait must dispose its timeout');
}
