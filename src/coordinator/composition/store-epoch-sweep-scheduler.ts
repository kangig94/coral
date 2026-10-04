import { formatError } from '../../infra/error-format.js';
import type { TimerHandle } from '../../infra/port-types.js';
import { refreshHistoricalEpochs, retryUnknownHistoricalEpochs } from '../../jobs/historical-reader.js';
import type { JobLocationIndex } from '../../jobs/location-index.js';
import type { Runtime } from '../../runtime/ports.js';
import { sweepStoreEpochsPostReady, type ResolvedStoreEpoch } from '../../store/epoch/index.js';
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
          void (async () => {
            retryUnknownHistoricalEpochs(jobLocationIndex);
            await settleSupersededEpochClosures(
              runtime,
              jobLocationIndex,
              controller.signal,
              undefined,
              input.selectedStoreEpochKey() ?? undefined,
              input.closeProxySetForEpochClosure,
            );
            if (!controller.signal.aborted) {
              refreshHistoricalEpochs(jobLocationIndex);
              void (await sweepStoreEpochsPostReady(
                runtime,
                { ...openStore, storeRoot: openStore.canonicalStoreRoot ?? openStore.storeRoot },
                {
                  signal: controller.signal,
                  resultsReleased: (epochKey) => jobLocationIndex.resultsReleased(epochKey),
                },
              ));
            }
          })()
            .catch((error: unknown) => {
              world.log(`Store epoch closure or retention sweep could not complete: ${formatError(error)}\n`);
            })
            .finally(() => {
              settleScheduled?.();
              settleScheduled = null;
              if (!controller.signal.aborted) schedule(5_000);
            });
        }, delayMs);
        timer.unref?.();
      };

      schedule(0);
    },
    stop: async () => {
      abort?.abort();
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
