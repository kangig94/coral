import assert from 'node:assert/strict';
import { withSuccessionHandover } from '#src/transport/dispatch.js';
for (const modern of [false, true]) {
  let cleaned = false;
  async function* upstream() {
    try {
      yield { type: 'progress', jobId: 'job-1', seq: 1, message: 'one' };
      yield { type: 'progress', jobId: 'job-1', seq: 2, message: 'two' };
    } finally {
      cleaned = true;
    }
  }
  const wrapped = withSuccessionHandover(upstream(), modern ? new AbortController().signal : undefined);
  await wrapped.next();
  await wrapped.return();
  console.log(JSON.stringify({ supportsHandover: modern, upstreamFinallyRan: cleaned }));
  if (modern) assert.equal(cleaned, true, 'Closing current wait wrapper must return its upstream iterator');
}

for (const exit of ['return', 'handover', 'read-error', 'completed']) {
  let returns = 0;
  const handover = new AbortController();
  const error = new Error('upstream failed');
  const upstream = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (exit === 'read-error') throw error;
      if (exit === 'handover') {
        handover.abort();
        return new Promise(() => {});
      }
      return { done: exit === 'completed', value: { type: 'progress', jobId: 'job-1', seq: 1 } };
    },
    async return() {
      returns++;
      return { done: true };
    },
  };
  const wrapped = withSuccessionHandover(upstream, handover.signal);
  if (exit === 'read-error') await assert.rejects(wrapped.next(), (cause) => cause === error);
  else {
    await wrapped.next();
    await wrapped.return();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returns, 1, `Upstream closes exactly once on ${exit}`);
}
const blocked = withSuccessionHandover(
  {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      return { done: false, value: { type: 'progress' } };
    },
    return() {
      return new Promise(() => {});
    },
  },
  new AbortController().signal,
);
await blocked.next();
await blocked.return();
console.log('Every wrapper exit closes once, and uncooperative cleanup cannot block');
