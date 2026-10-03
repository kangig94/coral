import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { raceObserved, raceWithPromise } from '#src/infra/promise-signal.js';
const held = new Promise(() => {});
const weak = [];
for (let index = 0; index < 10000; index++) {
  const event = { index };
  weak.push(new WeakRef(event));
  await raceObserved([Promise.resolve(event), held]);
  await raceWithPromise(Promise.resolve(event), held, () => event);
}
for (let index = 0; index < 4; index++) {
  await tick();
  global.gc();
}
const retained = weak.filter((ref) => ref.deref() !== undefined).length;
console.log(JSON.stringify({ retainedConsumedEvents: retained }));
assert.ok(retained <= 2, 'Repeated observation retained consumed events');
