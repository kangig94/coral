import type { KbCorpusPublication, KbCorpusPublishCallbacks, KbCorpusSnapshot } from '../contract.js';
import { buildCurrentCorpusSnapshot as buildRuntimeCorpusSnapshot } from '../state/corpus-snapshot-builder.js';
import type { KbIndexStore } from './index-store.js';
import { captureIndexStateSnapshot, mutationLanesFromDiff, type KbIndexStateSnapshot } from './lanes.js';
import type { ManifestAuthority } from './manifest-authority.js';
import { CorpusPublicationQueue, mergePublication } from './publication.js';
import type { KbRuntimeMutationLockContext } from './mutation-finalizer.js';

export interface CorpusPublicationServiceOptions {
  indexStore: KbIndexStore;
  manifestAuthority: ManifestAuthority;
  publicationQueue: CorpusPublicationQueue;
  getActiveMutationContext(): KbRuntimeMutationLockContext | null;
  setActivePublication(publication: KbCorpusPublication): void;
}

export class CorpusPublicationService {
  constructor(private readonly options: CorpusPublicationServiceOptions) {}

  register(corpusPublishCallbacks: KbCorpusPublishCallbacks): void {
    this.options.publicationQueue.register(corpusPublishCallbacks);
  }

  async retryPendingCorpusPublication(): Promise<void> {
    this.publishCurrentSnapshot();
    if (!this.options.publicationQueue.hasQueuedPublications()) {
      return;
    }

    await this.options.publicationQueue.process();
  }

  publishCurrentSnapshot(): void {
    const stateSnapshot = captureIndexStateSnapshot(this.options.indexStore.readIndexStateIfPresent());
    if (stateSnapshot.contentSeq === 0 && stateSnapshot.metadataSeq === 0) {
      return;
    }

    this.options.publicationQueue.enqueue({
      snapshot: this.buildCurrentCorpusSnapshot(stateSnapshot),
      changedLanes: ['content', 'metadata'],
    });
  }

  captureCorpusSnapshot(): KbCorpusSnapshot {
    return this.buildCurrentCorpusSnapshot(captureIndexStateSnapshot(this.options.indexStore.readIndexState()));
  }

  buildCurrentCorpusSnapshot(state: KbIndexStateSnapshot): KbCorpusSnapshot {
    return buildRuntimeCorpusSnapshot(state, this.options.manifestAuthority);
  }

  capturePublicationFromStateChange(
    previous: KbIndexStateSnapshot,
    next: KbIndexStateSnapshot,
    mutationContext: KbRuntimeMutationLockContext | null = this.options.getActiveMutationContext(),
  ): void {
    if (mutationContext === null) {
      return;
    }

    const changedLanes = mutationLanesFromDiff(previous, next);
    if (changedLanes.length === 0) {
      return;
    }

    this.options.setActivePublication(
      mergePublication(mutationContext.publication, {
        snapshot: this.buildCurrentCorpusSnapshot(next),
        changedLanes,
      }),
    );
  }
}
