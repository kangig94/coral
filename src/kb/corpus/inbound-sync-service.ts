import type {
  KbCorpusPublication,
  KbInboundSyncOptions,
  KbIndexMutationLane,
  KbMutationEffects,
} from '../contract.js';
import type { KbIndex } from '../entry-types.js';
import type { StoragePort } from '../../infra/port-types.js';
import {
  buildInboundSyncIndexDelta,
  captureCorpusFilesystemSnapshot,
  detectInboundSyncMutation,
  detectInboundSyncMutationFromFullCollectors,
  detectInboundSyncMutationFromStructuredDiff,
  isGitSyncResult,
  type InboundSyncMutationDiff,
} from './inbound-sync.js';
import type { KbIndexStore } from './index-store.js';
import type { ManifestAuthority } from './manifest-authority.js';
import type { ManifestAuthorityDelta } from './manifest-types.js';
import type { KbMutationLockController } from './mutation-lock.js';

export interface CorpusInboundSyncTarget {
  notesDir(): string;
  sourcesDir(): string;
  communitiesDir(): string;
  principlesDir(): string;
  entityGraphPath(): string;
  notePath(note: string): string;
  sourcePath(source: string): string;
  communityPath(community: string): string;
  principlePath(principle: string): string;
  storagePort: StoragePort;
}

export interface CorpusInboundSyncServiceOptions {
  indexStore: KbIndexStore;
  manifestAuthority: ManifestAuthority;
  mutationLockController: KbMutationLockController<
    KbIndex,
    KbCorpusPublication,
    KbIndexMutationLane,
    ManifestAuthorityDelta
  >;
  mutationEffects: KbMutationEffects;
  target: CorpusInboundSyncTarget;
  recordMutationCommitted(lane: KbIndexMutationLane, reason?: string): void;
  invalidateKbCache(): void;
}

export class CorpusInboundSyncService {
  constructor(private readonly options: CorpusInboundSyncServiceOptions) {}

  async runInboundSync<T>(fn: () => Promise<T> | T, options: KbInboundSyncOptions = {}): Promise<T> {
    let mutationDiff: InboundSyncMutationDiff | null = null;

    return this.options.mutationLockController.withMutationLock(async (lockContext) => {
      const target = this.options.target;
      const beforeSnapshot = options.structuredDiff === true ? null : captureCorpusFilesystemSnapshot(target);
      const result = await fn();

      if (options.structuredDiff === true && isGitSyncResult(result)) {
        if (result.kind === 'ambiguous') {
          mutationDiff = detectInboundSyncMutationFromFullCollectors(target, this.options.manifestAuthority, true);
        } else if (result.kind === 'paths') {
          mutationDiff = detectInboundSyncMutationFromStructuredDiff(
            result.changes,
            target,
            this.options.manifestAuthority,
          );
        } else {
          mutationDiff = {
            lane: null,
            changedEntryIds: [],
            requiresFullInstall: false,
            manifestDeltas: [],
          };
        }
      } else {
        mutationDiff = detectInboundSyncMutation(
          beforeSnapshot ?? captureCorpusFilesystemSnapshot(target),
          captureCorpusFilesystemSnapshot(target),
        );
        if (mutationDiff.lane !== null) {
          this.options.manifestAuthority.seedFromFullCollectors(target);
        }
      }

      if (mutationDiff.lane !== null) {
        if (mutationDiff.manifestDeltas.length > 0) {
          this.options.mutationEffects.queueManifestAuthorityDelta(mutationDiff.manifestDeltas);
        }
        if (!mutationDiff.requiresFullInstall && mutationDiff.changedEntryIds.length > 0) {
          this.options.indexStore.writeIndex(
            buildInboundSyncIndexDelta(lockContext.startIndex, mutationDiff.changedEntryIds, target),
          );
        } else if (mutationDiff.requiresFullInstall) {
          this.options.invalidateKbCache();
        }
        this.options.recordMutationCommitted(mutationDiff.lane, 'KB text snapshot is stale after inbound git sync.');
      }

      return result;
    });
  }
}
