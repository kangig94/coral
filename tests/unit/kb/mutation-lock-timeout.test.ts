import { describe, expect, it } from 'vitest';

import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import {
  createKbMutationLock,
  DEFAULT_MUTATION_LOCK_TIMEOUT_MS,
  KbMutationStuckError,
  type KbMutationLockRunner,
  type KbMutationLockTimePort,
} from '#src/kb/corpus/mutation-lock.js';
import type { CorpusSnapshot } from '#src/kb/corpus/snapshot.js';

// S7: KB mutation lock must enforce a deadline so a wedged operation cannot
// stall every queued caller indefinitely. Default 60s; per-call override.

type Index = { tag: string };
type Lane = 'content' | 'metadata' | 'both';
type Publication = { snapshot: CorpusSnapshot; changedLanes: Lane[] };

function createSpyRunner(): KbMutationLockRunner<Index, Publication, Lane> & {
  setActiveContextCalls: Array<unknown>;
  finalizeCalls: number;
} {
  let currentLock: Promise<void> = Promise.resolve();
  let finalizeCalls = 0;
  const setActiveContextCalls: Array<unknown> = [];

  return {
    cloneStartIndex: () => ({ tag: 'start' }),
    getCurrentLock: () => currentLock,
    setCurrentLock: (lock) => {
      currentLock = lock;
    },
    setActiveContext: (context) => {
      setActiveContextCalls.push(context);
    },
    finalizePendingMutation: () => {
      finalizeCalls += 1;
    },
    enqueuePublication: () => {},
    hasQueuedPublications: () => false,
    processPublishQueue: () => {},
    get setActiveContextCalls() {
      return setActiveContextCalls;
    },
    get finalizeCalls() {
      return finalizeCalls;
    },
  } as never;
}

function asTimePort(time: VirtualTime): KbMutationLockTimePort {
  return {
    setTimeout: (fn, ms) => time.setTimeout(fn, ms),
    clearTimeout: (handle) => time.clearTimeout(handle),
  };
}

describe('createKbMutationLock', () => {
  it('exposes the documented default timeout', () => {
    expect(DEFAULT_MUTATION_LOCK_TIMEOUT_MS).toBe(30_000);
  });

  it('throws kb_mutation_stuck and releases the lock when fn exceeds the timeout', async () => {
    const runner = createSpyRunner();
    const time = new VirtualTime();
    const controller = createKbMutationLock<Index, Publication, Lane>(runner, {
      defaultTimeoutMs: 1000,
      time: asTimePort(time),
    });

    let releaseHang!: () => void;
    const hang = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });

    const stuckPromise = controller.withMutationLock(async () => {
      await hang;
      return 'done' as const;
    });
    const errorPromise = stuckPromise.catch((error: unknown) => error);

    // Yield enough microtask rounds for `await previous` and `Promise.resolve().then(fn)`
    // to register the timer with the virtual clock before we advance it.
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }

    // Advance virtual time past the timeout; the rejection materializes.
    time.tick(1500);
    const error = await errorPromise;
    expect(error).toBeInstanceOf(KbMutationStuckError);
    expect((error as KbMutationStuckError).code).toBe('kb_mutation_stuck');
    expect((error as KbMutationStuckError).timeoutMs).toBe(1000);

    // Lock must be released so the next caller proceeds even though the
    // wedged fn is still in-flight.
    let nextRan = false;
    const nextPromise = controller.withMutationLock(async () => {
      nextRan = true;
      return 'second' as const;
    });
    expect(await nextPromise).toBe('second');
    expect(nextRan).toBe(true);

    // Drain the originally wedged fn so vitest does not warn about leaks.
    releaseHang();
  });

  it('honors a per-call timeoutMs override longer than the default', async () => {
    const runner = createSpyRunner();
    const time = new VirtualTime();
    const controller = createKbMutationLock<Index, Publication, Lane>(runner, {
      defaultTimeoutMs: 100,
      time: asTimePort(time),
    });

    const result = await controller.withMutationLock(
      async () => {
        // Simulate work that fits inside the override but exceeds the default.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'ok' as const;
      },
      { timeoutMs: 60_000 },
    );

    expect(result).toBe('ok');
  });
});
