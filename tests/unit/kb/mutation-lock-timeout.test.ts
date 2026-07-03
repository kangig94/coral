import { describe, expect, it } from 'vitest';

import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import {
  createKbMutationLock,
  DEFAULT_MUTATION_LOCK_TIMEOUT_MS,
  type KbMutationDeadlineReason,
  type KbMutationLockContext,
  type KbMutationLockRunner,
  type KbMutationLockTimePort,
} from '#src/kb/corpus/mutation-lock.js';
import type { CorpusSnapshot } from '#src/kb/corpus/snapshot.js';

// AC7: mutation-lock ownership-on-settle. The deadline aborts the composed
// signal but does NOT release the lock. Diagnostics surface the stuck owner
// on `/health.diagnostics.mutationBlocked` while the wedged fn is in flight.

type Index = { tag: string };
type Lane = 'content' | 'metadata' | 'both';
type Publication = { snapshot: CorpusSnapshot; changedLanes: Lane[] };

function createSpyRunner(): KbMutationLockRunner<Index, Publication, Lane> & {
  finalizeCalls: number;
  publications: Publication[];
  contextSnapshots: Array<KbMutationLockContext<Index, Publication, Lane> | null>;
  releaseFinalizeHang(): void;
  hangFinalize(): void;
} {
  let currentLock: Promise<void> = Promise.resolve();
  let finalizeCalls = 0;
  let finalizeHang: Promise<void> | null = null;
  let releaseFinalizeHang: (() => void) | null = null;
  const publications: Publication[] = [];
  const contextSnapshots: Array<KbMutationLockContext<Index, Publication, Lane> | null> = [];

  return {
    cloneStartIndex: () => ({ tag: 'start' }),
    getCurrentLock: () => currentLock,
    setCurrentLock: (lock: Promise<void>) => {
      currentLock = lock;
    },
    setActiveContext: (context: KbMutationLockContext<Index, Publication, Lane> | null) => {
      contextSnapshots.push(context);
    },
    finalizePendingMutation: async () => {
      finalizeCalls += 1;
      if (finalizeHang !== null) {
        await finalizeHang;
      }
    },
    enqueuePublication: (publication: Publication) => {
      publications.push(publication);
    },
    hasQueuedPublications: () => false,
    processPublishQueue: () => {},
    get finalizeCalls() {
      return finalizeCalls;
    },
    get publications() {
      return publications;
    },
    get contextSnapshots() {
      return contextSnapshots;
    },
    releaseFinalizeHang() {
      releaseFinalizeHang?.();
    },
    hangFinalize() {
      finalizeHang = new Promise<void>((resolve) => {
        releaseFinalizeHang = resolve;
      });
    },
  } as never;
}

function asTimePort(time: VirtualTime): KbMutationLockTimePort {
  return {
    now: () => time.now(),
    setTimeout: (fn, ms) => time.setTimeout(fn, ms),
    clearTimeout: (handle) => time.clearTimeout(handle),
  };
}

async function flushMicrotasks(rounds = 16): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

describe('createKbMutationLock', () => {
  it('exposes the documented default timeout', () => {
    expect(DEFAULT_MUTATION_LOCK_TIMEOUT_MS).toBe(30_000);
  });

  it('aborts composed signal with mutation_deadline reason but keeps the lock until fn settles', async () => {
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
    const observedSignalRef: { current: AbortSignal | null } = { current: null };

    const stuckPromise = controller.withMutationLock(async (lockCtx, { signal }) => {
      observedSignalRef.current = signal;
      lockCtx.pendingMutationReason = 'reindex';
      await hang;
      return 'done' as const;
    });

    await flushMicrotasks();
    expect(controller.diagnostics()).toEqual({ blocked: false });

    // Fire the deadline (timeout is 1000ms; tick just past it but not past
    // the grace window). Composed signal aborts with the documented reason
    // but the returned promise stays pending — fn has not settled.
    time.tick(1050);
    await flushMicrotasks();
    expect(observedSignalRef.current?.aborted).toBe(true);
    expect((observedSignalRef.current?.reason as KbMutationDeadlineReason).kind).toBe('mutation_deadline');
    expect((observedSignalRef.current?.reason as KbMutationDeadlineReason).timeoutMs).toBe(1000);

    // Cooperative grace window has not elapsed yet.
    expect(controller.diagnostics()).toEqual({ blocked: false });

    // After +100ms cooperative grace, diagnostics report the stuck owner from
    // the active mutation context's pendingMutationReason.
    time.tick(150);
    await flushMicrotasks();
    const blocked = controller.diagnostics();
    expect(blocked.blocked).toBe(true);
    if (!blocked.blocked) throw new Error('unreachable');
    expect(blocked.owner).toBe('reindex');
    expect(blocked.signaledAtMs).toBeGreaterThan(0);

    // The next caller is still waiting — the lock has not transferred.
    let nextRan = false;
    const nextPromise = controller.withMutationLock(async () => {
      nextRan = true;
      return 'second' as const;
    });
    await flushMicrotasks();
    expect(nextRan).toBe(false);

    // Settle fn; the lock releases, diagnostics clear, queued caller runs.
    releaseHang();
    expect(await stuckPromise).toBe('done');
    expect(await nextPromise).toBe('second');
    expect(controller.diagnostics()).toEqual({ blocked: false });
  });

  it("reports owner 'unknown' when deadline fires before pendingMutationReason is set", async () => {
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
      // Simulate fn stuck in pre-write I/O — never reaches recordMutationCommitted.
      await hang;
      return 'done' as const;
    });

    await flushMicrotasks();
    time.tick(1100); // past deadline
    await flushMicrotasks();
    time.tick(150); // past grace
    await flushMicrotasks();

    const blocked = controller.diagnostics();
    expect(blocked.blocked).toBe(true);
    if (!blocked.blocked) throw new Error('unreachable');
    expect(blocked.owner).toBe('unknown');

    releaseHang();
    expect(await stuckPromise).toBe('done');
    expect(controller.diagnostics()).toEqual({ blocked: false });
  });

  it('cooperative fn that settles within grace never surfaces as blocked', async () => {
    const runner = createSpyRunner();
    const time = new VirtualTime();
    const controller = createKbMutationLock<Index, Publication, Lane>(runner, {
      defaultTimeoutMs: 1000,
      time: asTimePort(time),
    });

    const result = await controller.withMutationLock(async (_lockCtx, { signal }) => {
      // Simulate a cooperative path that aborts immediately on signal.
      const aborted = new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      time.tick(1100); // fire the deadline
      try {
        await aborted;
      } catch {
        return 'cooperatively-stopped' as const;
      }
      return 'unreachable' as const;
    });

    expect(result).toBe('cooperatively-stopped');
    expect(controller.diagnostics()).toEqual({ blocked: false });
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

  it('propagates caller signal abort with caller reason', async () => {
    const runner = createSpyRunner();
    const time = new VirtualTime();
    const controller = createKbMutationLock<Index, Publication, Lane>(runner, {
      defaultTimeoutMs: 60_000,
      time: asTimePort(time),
    });

    const callerController = new AbortController();
    const callerReason = { kind: 'user_abort' as const };

    const promise = controller.withMutationLock(
      async (_lockCtx, { signal }) => {
        await new Promise<never>((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(Object.assign(new Error('aborted'), { reason: signal.reason }));
            },
            { once: true },
          );
        });
        return 'unreachable' as const;
      },
      { signal: callerController.signal },
    );

    await flushMicrotasks();
    callerController.abort(callerReason);

    await expect(promise).rejects.toMatchObject({ reason: callerReason });
  });

  it('enqueues publication for finalized mutation before propagating postFinalize failure', async () => {
    const runner = createSpyRunner();
    const time = new VirtualTime();
    const controller = createKbMutationLock<Index, Publication, Lane>(runner, {
      defaultTimeoutMs: 1000,
      time: asTimePort(time),
    });
    const publication: Publication = {
      snapshot: {} as CorpusSnapshot,
      changedLanes: ['content'],
    };
    const postFinalizeError = new Error('post finalize failed');

    await expect(
      controller.withMutationLock(
        async (lockCtx) => {
          lockCtx.publication = publication;
          return 'committed' as const;
        },
        {
          postFinalize: async () => {
            throw postFinalizeError;
          },
        },
      ),
    ).rejects.toBe(postFinalizeError);

    expect(runner.finalizeCalls).toBe(1);
    expect(runner.publications).toEqual([publication]);
  });

  it('keeps mutationBlocked watchdog active while finalize is hung', async () => {
    const runner = createSpyRunner();
    runner.hangFinalize();
    const time = new VirtualTime();
    const controller = createKbMutationLock<Index, Publication, Lane>(runner, {
      defaultTimeoutMs: 1000,
      time: asTimePort(time),
    });

    const promise = controller.withMutationLock(async (lockCtx) => {
      lockCtx.pendingMutationReason = 'finalize';
      return 'done' as const;
    });

    await flushMicrotasks();
    time.tick(1100);
    await flushMicrotasks();
    time.tick(150);
    await flushMicrotasks();

    const blocked = controller.diagnostics();
    expect(blocked.blocked).toBe(true);
    if (!blocked.blocked) throw new Error('unreachable');
    expect(blocked.owner).toBe('finalize');

    runner.releaseFinalizeHang();
    expect(await promise).toBe('done');
    expect(controller.diagnostics()).toEqual({ blocked: false });
  });
});
