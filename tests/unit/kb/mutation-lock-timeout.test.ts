import { expect, it } from 'vitest';

import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { createKbMutationLock, type KbMutationLockRunner } from '#src/kb/corpus/mutation-lock.js';
import type { CorpusSnapshot } from '#src/kb/corpus/snapshot.js';

function createLock(finalize: () => Promise<void> = async () => {}) {
  const time = new VirtualTime();
  let currentLock = Promise.resolve();
  const runner: KbMutationLockRunner<null, { snapshot: CorpusSnapshot }, never> = {
    cloneStartIndex: () => null,
    getCurrentLock: () => currentLock,
    setCurrentLock: (lock) => {
      currentLock = lock;
    },
    setActiveContext: () => {},
    finalizePendingMutation: finalize,
    enqueuePublication: () => {},
    hasQueuedPublications: () => false,
    processPublishQueue: () => {},
  };
  const lock = createKbMutationLock(runner, {
    defaultTimeoutMs: 1000,
    time: {
      now: () => time.now(),
      setTimeout: (fn, ms) => time.setTimeout(fn, ms),
      clearTimeout: (handle) => time.clearTimeout(handle),
    },
  });
  return { time, lock };
}

async function flushMicrotasks() {
  for (let i = 0; i < 16; i += 1) {
    await Promise.resolve();
  }
}

it('keeps ownership after the deadline until the body settles', async () => {
  const { time, lock } = createLock();
  const body = createDeferred<void>();
  const entered = createDeferred<AbortSignal>();
  const first = lock.withMutationLock(async (context, { signal }) => {
    context.pendingMutationReason = 'reindex';
    entered.resolve(signal);
    await body.promise;
  });
  const signal = await entered.promise;

  time.tick(1050);
  expect(signal.aborted).toBe(true);
  expect(signal.reason).toEqual({ kind: 'mutation_deadline', timeoutMs: 1000 });
  expect(lock.diagnostics()).toEqual({ blocked: false });
  time.tick(150);
  expect(lock.diagnostics()).toMatchObject({ blocked: true, owner: 'reindex' });

  let nextRan = false;
  const next = lock.withMutationLock(() => {
    nextRan = true;
  });
  await flushMicrotasks();
  expect(nextRan).toBe(false);
  body.resolve();
  await first;
  await next;
  expect(nextRan).toBe(true);
  expect(lock.diagnostics()).toEqual({ blocked: false });
});

it('diagnoses hung finalization until it settles', async () => {
  const finalize = createDeferred<void>();
  const entered = createDeferred<void>();
  const { time, lock } = createLock(async () => {
    entered.resolve();
    await finalize.promise;
  });
  const run = lock.withMutationLock((context) => {
    context.pendingMutationReason = 'finalize';
  });
  await entered.promise;
  time.tick(1100);
  time.tick(150);
  expect(lock.diagnostics()).toMatchObject({ blocked: true, owner: 'finalize' });
  finalize.resolve();
  await run;
  expect(lock.diagnostics()).toEqual({ blocked: false });
});
