import type { EnsureCorpusFreshnessOptions, KbIndexState, KbRuntime } from '../contract.js';
import type { KbIndex } from '../entry-types.js';
import { emptyIndex, isFreshTextSnapshot, type KbIndexStore } from './index/store.js';
import { captureIndexStateSnapshot } from './lanes.js';
import { detectRescanInfo } from './rescan/drift.js';
import { performRescan } from './rescan/index.js';
import { buildCorpusScanViewInWorker } from './rescan/scan-worker.js';

const MAX_REBUILD_COMMIT_ATTEMPTS = 2;

export interface CorpusFreshnessServiceOptions {
  indexStore: KbIndexStore;
  getRuntime(): KbRuntime;
}

function waitForRebuild(rebuild: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    return rebuild;
  }
  if (signal.aborted) {
    return Promise.reject(new Error('ensureCorpusFreshness aborted before rebuild completed.'));
  }

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new Error('ensureCorpusFreshness aborted before rebuild completed.'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    rebuild.then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export class CorpusFreshnessService {
  private rebuildInFlight: Promise<void> | null = null;

  private readonly options: CorpusFreshnessServiceOptions;
  constructor(options: CorpusFreshnessServiceOptions) {
    this.options = options;
  }

  async ensureCorpusFreshness(options: EnsureCorpusFreshnessOptions = {}): Promise<KbIndex> {
    const wait = options.wait ?? false;
    const signal = options.signal;

    if (await this.textArtifactsNeedRebuild()) {
      if (signal?.aborted !== true) {
        this.rebuildInFlight ??= this.runRebuildOnce().finally(() => {
          this.rebuildInFlight = null;
        });

        if (wait) {
          await waitForRebuild(this.rebuildInFlight, signal);
        }
      } else if (wait) {
        throw new Error('ensureCorpusFreshness aborted before rebuild started.');
      }
    }

    return this.options.indexStore.readIndex() ?? emptyIndex();
  }

  private async runRebuildOnce(): Promise<void> {
    for (let attempt = 0; attempt < MAX_REBUILD_COMMIT_ATTEMPTS; attempt += 1) {
      const state = this.options.indexStore.readIndexStateIfPresent();
      if (!(await this.textArtifactsNeedRebuild(state))) {
        return;
      }

      const result = await performRescan(this.options.getRuntime(), captureIndexStateSnapshot(state));
      if (result.status === 'committed') {
        return;
      }
    }
  }

  private async indexNeedsRebuild(): Promise<boolean> {
    const runtime = this.options.getRuntime();
    return (await detectRescanInfo(runtime, await buildCorpusScanViewInWorker(runtime))).needsRebuild;
  }

  private async textArtifactsNeedRebuild(state?: KbIndexState | null): Promise<boolean> {
    const currentState = state === undefined ? this.options.indexStore.readIndexStateIfPresent() : state;
    return !isFreshTextSnapshot(currentState) || (await this.indexNeedsRebuild());
  }
}
