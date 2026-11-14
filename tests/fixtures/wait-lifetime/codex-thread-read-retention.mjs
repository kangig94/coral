import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { observeCodexThreadRead } from '#src/providers/codex/thread-read.js';

let resolveReply;
let answered = false;
let requests = 0;
const reply = new Promise((resolve) => (resolveReply = resolve));
const lease = {
  closed: new Promise(() => {}),
  rpc() {
    requests++;
    return reply;
  },
  subscribe: () => () => {},
};
const stopped = [];
function stopReader(index) {
  const state = { index };
  stopped.push(new WeakRef(state));
  const stop = observeCodexThreadRead(lease, 'thread-1', () => state.index);
  stop();
}
for (let index = 0; index < 256; index++) stopReader(index);
function keepReader() {
  const state = { active: true };
  observeCodexThreadRead(lease, 'thread-1', () => {
    answered = state.active;
  });
  return new WeakRef(state);
}
const active = keepReader();
for (let index = 0; index < 4; index++) {
  await tick();
  global.gc();
}
const retained = stopped.filter((ref) => ref.deref() !== undefined).length;
assert.equal(retained, 0, 'Stopped readers retained turn state while the RPC stayed pending');
assert.notEqual(active.deref(), undefined, 'The pending request must keep its active reader alive');
assert.equal(answered, false);
assert.equal(requests, 1);
const stop = observeCodexThreadRead(lease, 'thread-1', () => {});
assert.equal(requests, 1, 'The same lease must still own its unanswered request');
stop();
resolveReply({ thread: { id: 'thread-1', turns: [] } });
await tick();
assert.equal(answered, true);
console.log(JSON.stringify({ retainedStoppedReaders: retained, requests }));
