import { createBackgroundPhaseObserver } from '../../recovery/phase-observation.js';
import { sameEpoch } from '../../store/epoch/identity.js';
import type { TimerHandle } from '../../infra/port-types.js';
import {
  registerPresentHistoricalEpochs,
  refreshHistoricalEpochs,
  retryUnknownHistoricalEpochs,
  onHistoricalHydrationHint,
} from '../../jobs/historical-reader.js';
import type { JobLocationIndex } from '../../jobs/location-index.js';
import type { Runtime } from '../../runtime/ports.js';
import { listStoreEpochs, sweepStoreEpochsPostReady, type ResolvedStoreEpoch } from '../../store/epoch/index.js';
import { settleSupersededEpochClosures } from '../services/recovery/epoch-closure.js';
import type { CoordinatorWorld } from './world.js';

export function createStoreEpochSweepScheduler(input: {
  runtime: Runtime;
  bootId: string;
  world: Pick<CoordinatorWorld, 'log'>;
  jobLocationIndex: JobLocationIndex;
  selectedStoreEpochKey: () => string | null;
  onOpen: (openStore: ResolvedStoreEpoch) => void;
  closeProxySetForEpochClosure: Parameters<typeof settleSupersededEpochClosures>[5];
}): Readonly<{ schedule: (openStore: ResolvedStoreEpoch) => void; stop: () => Promise<void> }> {
  const { runtime, world, jobLocationIndex } = input;
  let abort: AbortController | null = null;
  let timer: TimerHandle | null = null;
  let settleScheduled: (() => void) | null = null;
  let settlement = Promise.resolve();
  let lastSweepStart = -Infinity;
  let lastSweepDuration = 0;
  const startPhase = createBackgroundPhaseObserver({
    time: runtime.time,
    log: world.log,
    bootId: input.bootId,
    phase: 'store-epoch-sweep',
  });

  return {
    schedule: (openStore) => {
      input.onOpen(openStore);
      const controller = new AbortController();
      abort = controller;
      const schedule = (delayMs: number): void => {
        settlement = new Promise<void>((resolveSweep) => {
          settleScheduled = resolveSweep;
        });
        timer = runtime.time.setTimeout(() => {
          timer = null;
          lastSweepStart = Number(runtime.time.monotonicNow());
          const observation = startPhase(controller.signal);
          let cancelled = false;
          let observed = false;
          const holds: { identity: string; reason: string }[] = [];
          let failed = false;
          void (async () => {
            const budget = { remaining: 0 };
            try {
              const epochs = listStoreEpochs(runtime);
              observation.record('store-epochs', { reads: epochs.length });
              registerPresentHistoricalEpochs(runtime, jobLocationIndex, epochs, input.selectedStoreEpochKey(), budget);
            } catch (error) {
              failed = true;
              holds.push({ identity: openStore.path, reason: `historical-registration: ${String(error)}` });
            }
            await retryUnknownHistoricalEpochs(jobLocationIndex, budget);
            try {
              await settleSupersededEpochClosures(
                runtime,
                jobLocationIndex,
                controller.signal,
                undefined,
                input.selectedStoreEpochKey() ?? undefined,
                input.closeProxySetForEpochClosure,
              );
            } catch (error) {
              failed = true;
              holds.push({ identity: openStore.path, reason: `epoch-closure: ${String(error)}` });
            }
            if (!controller.signal.aborted) {
              await refreshHistoricalEpochs(jobLocationIndex, budget);
              const result = await sweepStoreEpochsPostReady(
                runtime,
                { ...openStore, storeRoot: openStore.canonicalStoreRoot ?? openStore.storeRoot },
                {
                  signal: controller.signal,
                  observation,
                  resultsReleased: (epochKey, closedSource) =>
                    jobLocationIndex.resultsReleasedAsync(epochKey, controller.signal, closedSource),
                },
              );
              cancelled = result === 'cancelled';
              observed = !cancelled;
              if (result !== 'complete' && !cancelled) holds.push({ identity: openStore.path, reason: result });
            }
          })()
            .catch((error: unknown) => {
              failed = true;
              holds.push({ identity: openStore.path, reason: `store-epoch-sweep: ${String(error)}` });
            })
            .finally(() => {
              if (!cancelled && !controller.signal.aborted && (observed || holds.length > 0)) {
                holds.sort(
                  (left, right) =>
                    left.identity.localeCompare(right.identity) || left.reason.localeCompare(right.reason),
                );
                observation.reportState(holds.length === 0 ? null : JSON.stringify(holds));
              }
              observation.finish(cancelled ? 'cancelled' : failed ? 'failed' : 'complete');
              lastSweepDuration = Number(runtime.time.monotonicNow()) - lastSweepStart;
              settleScheduled?.();
              settleScheduled = null;
              if (!controller.signal.aborted) schedule(5_000);
            });
        }, delayMs);
        timer.unref?.();
      };

      onHistoricalHydrationHint(jobLocationIndex, (epochKey) => {
        if (sameEpoch(epochKey, input.selectedStoreEpochKey()) || controller.signal.aborted || timer === null) return;
        runtime.time.clearTimeout(timer);
        timer = null;
        settleScheduled?.();
        // A hint may bring the next sweep forward to 5 s after the previous one began, but sweeping may never
        // occupy more than half the time, however long one sweep takes.
        const earliest = lastSweepStart + Math.max(5_000, 2 * lastSweepDuration);
        schedule(Math.max(0, earliest - Number(runtime.time.monotonicNow())));
      });
      schedule(0);
    },
    stop: async () => {
      abort?.abort();
      onHistoricalHydrationHint(jobLocationIndex, null);
      if (timer !== null) {
        runtime.time.clearTimeout(timer);
        timer = null;
        settleScheduled?.();
        settleScheduled = null;
      }
      await settlement;
    },
  };
}
