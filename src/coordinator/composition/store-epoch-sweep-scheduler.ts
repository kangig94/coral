import { sameEpoch } from '../../store/epoch/identity.js';
import { formatError } from '../../infra/error-format.js';
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
          void (async () => {
            const budget = { remaining: 0 };
            try {
              registerPresentHistoricalEpochs(
                runtime,
                jobLocationIndex,
                listStoreEpochs(runtime),
                input.selectedStoreEpochKey(),
                budget,
              );
            } catch (error) {
              world.log(`Historical epoch registration could not complete: ${formatError(error)}\n`);
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
              world.log(`Superseded epoch closure could not complete: ${formatError(error)}\n`);
            }
            if (!controller.signal.aborted) {
              await refreshHistoricalEpochs(jobLocationIndex, budget);
              void (await sweepStoreEpochsPostReady(
                runtime,
                { ...openStore, storeRoot: openStore.canonicalStoreRoot ?? openStore.storeRoot },
                {
                  signal: controller.signal,
                  resultsReleased: (epochKey, closedSource) => jobLocationIndex.resultsReleased(epochKey, closedSource),
                },
              ));
            }
          })()
            .catch((error: unknown) => {
              world.log(`Store epoch closure or retention sweep could not complete: ${formatError(error)}\n`);
            })
            .finally(() => {
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
