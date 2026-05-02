import type {
  EnsureCorpusFreshnessOptions,
  KbCorpusPublication,
  KbIndexMutationLane,
  KbIndexState,
  KbMutationEffects,
  KbRuntime,
} from '../contract.js';
import type { KbIndex } from '../entry-types.js';
import { emptyIndex, isFreshTextSnapshot, type KbIndexStore } from './index-store.js';
import { captureIndexStateSnapshot } from './lanes.js';
import type { ManifestAuthorityDelta } from './manifest-types.js';
import type { KbMutationLockController } from './mutation-lock.js';
import { detectRescanInfo } from './rescan/drift.js';
import { performRescan } from './rescan/index.js';
import { buildCorpusScanView } from './rescan/scan.js';

export interface CorpusFreshnessServiceOptions {
  indexStore: KbIndexStore;
  mutationLockController: KbMutationLockController<
    KbIndex,
    KbCorpusPublication,
    KbIndexMutationLane,
    ManifestAuthorityDelta
  >;
  mutationEffects: KbMutationEffects;
  getRuntime(): KbRuntime;
}

export class CorpusFreshnessService {
  private rebuildInFlight: Promise<void> | null = null;

  constructor(private readonly options: CorpusFreshnessServiceOptions) {}

  async ensureCorpusFreshness(options: EnsureCorpusFreshnessOptions = {}): Promise<KbIndex> {
    const wait = options.wait ?? false;
    const signal = options.signal;

    if (await this.textArtifactsNeedRebuild()) {
      if (signal?.aborted !== true) {
        this.rebuildInFlight ??= this.runRebuildOnce(signal).finally(() => {
          this.rebuildInFlight = null;
        });

        if (wait) {
          await this.rebuildInFlight;
        }
      } else if (wait) {
        throw new Error('ensureCorpusFreshness aborted before rebuild started.');
      }
    }

    return this.options.indexStore.readIndex() ?? emptyIndex();
  }

  private async runRebuildOnce(signal?: AbortSignal): Promise<void> {
    await this.options.mutationLockController.withMutationLock(
      async (_lockContext, { signal: lockSignal }) => {
        const state = this.options.indexStore.readIndexStateIfPresent();
        if (!(await this.textArtifactsNeedRebuild(state))) {
          return;
        }

        await performRescan(this.options.getRuntime(), this.options.mutationEffects, captureIndexStateSnapshot(state), {
          signal: lockSignal,
        });
      },
      { ...(signal === undefined ? {} : { signal }) },
    );
  }

  private async indexNeedsRebuild(): Promise<boolean> {
    const runtime = this.options.getRuntime();
    return (await detectRescanInfo(runtime, buildCorpusScanView(runtime))).needsRebuild;
  }

  private async textArtifactsNeedRebuild(state?: KbIndexState | null): Promise<boolean> {
    const currentState = state === undefined ? this.options.indexStore.readIndexStateIfPresent() : state;
    return !isFreshTextSnapshot(currentState) || (await this.indexNeedsRebuild());
  }
}
