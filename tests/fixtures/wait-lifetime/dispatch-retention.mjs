import { withSuccessionHandover } from '#src/transport/dispatch.js';
import { setImmediate as tick } from 'node:timers/promises';
import assert from 'node:assert/strict';
const modern = process.argv[2] !== 'legacy';
const weak = [];
let ready, finish;
const reached = new Promise((r) => (ready = r)),
  held = new Promise((r) => (finish = r));
async function* upstream() {
  for (let i = 0; i < 10000; i++) {
    const e = { type: 'progress', jobId: 'job-1', seq: i + 1, message: 'event-' + i };
    weak.push(new WeakRef(e));
    yield e;
  }
  ready();
  await held;
}
const wrapped = withSuccessionHandover(upstream(), modern ? new AbortController().signal : undefined);
const consuming = (async () => {
  for await (const event of wrapped) {
  }
})();
await reached;
for (let i = 0; i < 4; i++) {
  await tick();
  global.gc();
}
const retained = weak.reduce((n, r) => n + Number(r.deref() !== undefined), 0);
console.log(JSON.stringify({ supportsHandover: modern, consumedEvents: 10000, retainedConsumedEvents: retained }));
finish();
await consuming;
assert.ok(retained <= 2, 'Handover wrapper retained ' + retained + ' consumed events');
