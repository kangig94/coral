import type { KbCorpusPublishCallbacks, KbCorpusPublication, KbPersistCorpusStateResult } from '../contract.js';
import type { CorpusSnapshot } from './snapshot.js';
import { mergeCorpusLanes } from './lanes.js';

type PublishQueueEntry = {
  publication: KbCorpusPublication;
  persisted: boolean;
};

export const NOOP_CORPUS_PUBLISH_CALLBACKS: KbCorpusPublishCallbacks = {
  persistCorpusState(snapshot) {
    return {
      snapshot,
      changedLanes: [],
    };
  },
  notifyCorpusMutation() {},
};

export function sameCorpusSnapshot(left: CorpusSnapshot, right: CorpusSnapshot): boolean {
  return (
    left.snapshotId === right.snapshotId &&
    left.contentSeq === right.contentSeq &&
    left.metadataSeq === right.metadataSeq &&
    left.contentManifestHash === right.contentManifestHash &&
    left.metadataManifestHash === right.metadataManifestHash
  );
}

function isLaterSnapshot(next: CorpusSnapshot, current: CorpusSnapshot): boolean {
  return (
    next.contentSeq > current.contentSeq ||
    next.metadataSeq > current.metadataSeq ||
    (next.contentSeq === current.contentSeq &&
      next.metadataSeq === current.metadataSeq &&
      next.snapshotId !== current.snapshotId)
  );
}

export function mergePublication(current: KbCorpusPublication | null, next: KbCorpusPublication): KbCorpusPublication {
  if (current === null) {
    return {
      snapshot: { ...next.snapshot },
      changedLanes: [...next.changedLanes].sort(),
    };
  }

  return {
    snapshot: {
      ...(isLaterSnapshot(next.snapshot, current.snapshot) ? next.snapshot : current.snapshot),
    },
    changedLanes: mergeCorpusLanes(current.changedLanes, next.changedLanes),
  };
}

export interface CorpusPublicationQueueOptions {
  readCorpusStateSnapshot(): CorpusSnapshot;
  invalidateCorpusStateSnapshot(): void;
}

export class CorpusPublicationQueue {
  private callbacks: KbCorpusPublishCallbacks = NOOP_CORPUS_PUBLISH_CALLBACKS;
  private readonly queue: PublishQueueEntry[] = [];
  private drain: Promise<void> | null = null;
  private drainRequested = false;
  private consecutiveFailureCount = 0;

  private readonly options: CorpusPublicationQueueOptions;
  constructor(options: CorpusPublicationQueueOptions) {
    this.options = options;
  }

  register(callbacks: KbCorpusPublishCallbacks): void {
    this.callbacks = callbacks;
  }

  enqueue(publication: KbCorpusPublication): void {
    this.queue.push({
      publication,
      persisted: false,
    });
  }

  hasQueuedPublications(): boolean {
    return this.queue.length > 0;
  }

  async process(): Promise<void> {
    if (this.drain !== null) {
      this.drainRequested = true;
      return this.drain;
    }

    this.drainRequested = false;
    const drain = Promise.resolve().then(async () => {
      try {
        while (this.queue.length > 0) {
          const current = this.queue[0];
          if (current === undefined) {
            return;
          }

          if (!current.persisted) {
            const mirrorBeforePersist = this.options.readCorpusStateSnapshot();
            try {
              const persisted = await this.callbacks.persistCorpusState(current.publication.snapshot);
              current.publication = this.normalizePersistResult(current.publication, persisted);
              if (!sameCorpusSnapshot(mirrorBeforePersist, current.publication.snapshot)) {
                this.options.invalidateCorpusStateSnapshot();
              }
              current.persisted = true;
            } catch (error: unknown) {
              this.consecutiveFailureCount += 1;
              this.callbacks.onPublishFailure?.({
                stage: 'persist',
                snapshot: current.publication.snapshot,
                changedLanes: current.publication.changedLanes,
                consecutivePublishFailureCount: this.consecutiveFailureCount,
                error,
              });
              return;
            }
          }

          if (current.publication.changedLanes.length === 0) {
            this.queue.shift();
            this.consecutiveFailureCount = 0;
            this.callbacks.onPublishSuccess?.();
            continue;
          }

          try {
            await this.callbacks.notifyCorpusMutation(current.publication);
          } catch (error: unknown) {
            this.consecutiveFailureCount += 1;
            this.callbacks.onPublishFailure?.({
              stage: 'notify',
              snapshot: current.publication.snapshot,
              changedLanes: current.publication.changedLanes,
              consecutivePublishFailureCount: this.consecutiveFailureCount,
              error,
            });
            return;
          }

          this.queue.shift();
          this.consecutiveFailureCount = 0;
          this.callbacks.onPublishSuccess?.();
        }
      } finally {
        if (this.drain === drain) {
          this.drain = null;
        }
        const shouldRestart = this.queue.length > 0 && this.drainRequested;
        this.drainRequested = false;
        if (shouldRestart) {
          void this.process();
        }
      }
    });
    this.drain = drain;

    return drain;
  }

  private normalizePersistResult(
    fallbackPublication: KbCorpusPublication,
    result: KbPersistCorpusStateResult | void,
  ): KbCorpusPublication {
    if (result === undefined) {
      return {
        snapshot: fallbackPublication.snapshot,
        changedLanes: [...fallbackPublication.changedLanes],
      };
    }

    return {
      snapshot: result.snapshot,
      changedLanes: [...result.changedLanes].sort(),
    };
  }
}
