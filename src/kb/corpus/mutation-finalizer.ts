import type { KbCorpusPublication, KbIndexMutationLane, KbIndexState, KbMutationEffects } from '../contract.js';
import type { EntityGraph, KbIndex } from '../entry-types.js';
import type { FileAtomicHost } from './file-atomic.js';
import { writeEntityGraphFile } from './entity-graph-store.js';
import type { KbIndexStore } from './index-store.js';
import { cloneKbIndex } from './index-records.js';
import { previewPendingMutationState, type KbIndexStateSnapshot } from './lanes.js';
import { captureEntityGraphManifestDelta, type ManifestAuthority } from './manifest-authority.js';
import type { ManifestAuthorityDelta } from './manifest-types.js';
import type { KbMutationLockContext } from './mutation-lock.js';

export type KbRuntimeMutationLockContext = KbMutationLockContext<
  KbIndex,
  KbCorpusPublication,
  KbIndexMutationLane,
  ManifestAuthorityDelta
>;

export interface CorpusMutationFinalizerOptions {
  indexStore: KbIndexStore;
  manifestAuthority: ManifestAuthority;
  entityGraphHost: FileAtomicHost;
  entityGraphPath(): string;
  getActiveMutationContext(): KbRuntimeMutationLockContext | null;
  recordMutationCommitted(lane?: KbIndexMutationLane, reason?: string): KbIndexState;
  refreshAuthorityBaselineForPendingDeltas(deltas: readonly ManifestAuthorityDelta[]): void;
  capturePublication(
    previous: KbIndexStateSnapshot,
    next: KbIndexStateSnapshot,
    mutationContext: KbRuntimeMutationLockContext,
  ): void;
}

export class CorpusMutationFinalizer {
  readonly mutationEffects: KbMutationEffects;

  constructor(private readonly options: CorpusMutationFinalizerOptions) {
    this.mutationEffects = {
      queueManifestAuthorityDelta: (deltas) => {
        this.queueManifestAuthorityDelta(deltas);
      },
      writeEntityGraph: (graph) => {
        this.writeEntityGraphLocked(graph);
      },
    };
  }

  finalizePendingMutation(lockContext: KbRuntimeMutationLockContext): void {
    this.applyPendingManifestAuthorityDeltas(lockContext);
    if (lockContext.pendingMutationLane === null) {
      return;
    }

    const nextState = previewPendingMutationState(this.options.indexStore.readIndexState(), lockContext);
    this.options.indexStore.writeIndexState(nextState);
    this.refreshIndexBaselineIfPresent();
    this.options.refreshAuthorityBaselineForPendingDeltas(lockContext.pendingOpaqueDeltas);
  }

  capturePublicationFromStateChange(previous: KbIndexStateSnapshot, next: KbIndexStateSnapshot): void {
    const mutationContext = this.options.getActiveMutationContext();
    if (mutationContext === null) {
      return;
    }

    this.options.capturePublication(previous, next, mutationContext);
  }

  refreshIndexBaselineIfPresent(): void {
    const currentIndex = this.options.indexStore.readIndex();
    if (currentIndex === null) {
      return;
    }

    this.options.indexStore.persistIndexToDisk(currentIndex);
  }

  private writeEntityGraphLocked(graph: EntityGraph): void {
    const { normalized, raw } = writeEntityGraphFile(
      this.options.entityGraphHost,
      this.options.entityGraphPath(),
      graph,
    );
    this.queueManifestAuthorityDelta(captureEntityGraphManifestDelta(raw));
    this.options.recordMutationCommitted('metadata', 'KB entity graph changed.');

    const currentIndex = this.options.indexStore.readIndex();
    if (currentIndex !== null) {
      const nextIndex = cloneKbIndex(currentIndex);
      nextIndex.entityMeta = normalized.entityMeta;
      nextIndex.relationships = normalized.relationships;
      this.options.indexStore.writeIndex(nextIndex);
    }
  }

  private queueManifestAuthorityDelta(deltas: readonly ManifestAuthorityDelta[]): void {
    const mutationContext = this.options.getActiveMutationContext();
    if (mutationContext === null) {
      throw new Error('KB manifest authority deltas can only be queued while the mutation lock is held.');
    }

    mutationContext.pendingOpaqueDeltas.push(...deltas);
  }

  private applyPendingManifestAuthorityDeltas(lockContext: KbRuntimeMutationLockContext): void {
    if (lockContext.pendingOpaqueDeltas.length === 0) {
      return;
    }

    this.options.manifestAuthority.updateFromDelta(lockContext.pendingOpaqueDeltas);
  }
}
