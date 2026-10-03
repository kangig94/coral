import {
  createSemanticOperationEventPump,
  createStagedOperationEntry,
} from '#src/provider-proxy/semantic-operation-runner.js';
import { setImmediate as tick } from 'node:timers/promises';
import assert from 'node:assert/strict';
const count = 10000;
const weak = [];
const key = { jobId: 'job-1', operationId: 'operation-1' };
const entry = createStagedOperationEntry(key, new AbortController(), {});
entry.startCommitted = true;
entry.cancellationMode = 'shared-acknowledged-interrupt';
let ready, finish;
const reached = new Promise((r) => (ready = r));
const held = new Promise((r) => (finish = r));
let emitted = 0;
const proxy = {
  emitProviderEvent() {
    emitted++;
    return { kind: 'recorded', providerSeq: emitted };
  },
};
const pump = createSemanticOperationEventPump(
  () => proxy,
  () => {},
);
async function* events() {
  for (let i = 0; i < count; i++) {
    const event = { kind: 'progress', message: 'provider-event-' + i };
    weak.push(new WeakRef(event));
    yield event;
  }
  ready();
  await held;
  yield {
    kind: 'terminal',
    terminal: { content: 'done', outcome: { kind: 'completed' }, durationMs: 0 },
    diagnostics: {},
  };
}
const running = pump.runPump(key, entry, 'codex', events(), () => {});
await reached;
for (let i = 0; i < 4; i++) {
  await tick();
  global.gc();
}
const retained = weak.reduce((n, r) => n + Number(r.deref() !== undefined), 0);
console.log(JSON.stringify({ consumedProviderEvents: emitted, retainedConsumedEvents: retained }));
finish();
await running;
for (let i = 0; i < 4; i++) {
  await tick();
  global.gc();
}
console.log(
  JSON.stringify({ afterTerminalRetainedEvents: weak.reduce((n, r) => n + Number(r.deref() !== undefined), 0) }),
);
entry.resolveTransportClosed();
for (let i = 0; i < 4; i++) {
  await tick();
  global.gc();
}
console.log(
  JSON.stringify({ afterTransportClosedRetainedEvents: weak.reduce((n, r) => n + Number(r.deref() !== undefined), 0) }),
);
assert.ok(retained <= 2, 'Provider pump retained ' + retained + ' consumed provider events');
