import type { KbCorpusPublication, KbInboundSyncOptions, KbIndexMutationLane, KbMutationEffects } from '../contract.js';
import type { KbIndex } from '../entry-types.js';
import type { StoragePort } from '../../infra/port-types.js';
import type { CorpusStorage } from './rescan/storage.js';
import {
  buildInboundSyncIndexDelta,
  detectInboundSyncMutation,
  detectInboundSyncMutationFromSurface,
  detectInboundSyncMutationFromStructuredDiff,
  isGitSyncResult,
  type InboundSyncMutationDiff,
} from './inbound-sync.js';
import type { KbIndexStore } from './index/store.js';
import type { ManifestAuthority } from './manifest-authority.js';
import type { ManifestAuthorityDelta } from './manifest-types.js';
import type { KbMutationLockController } from './mutation-lock.js';
import { readEntityGraphFile, renderEntityGraph } from './entity-graph-store.js';
import { buildCorpusSurface, type CorpusSurface } from './surface.js';
import { buildCorpusScanView } from './rescan/scan.js';
import { consolidateCanonicalEntityGraph } from '../curate/entity-graph-merge-driver.js';

function isEntityGraphSyncPath(path: string): boolean {
  return path.replace(/\\/g, '/').replace(/^\.\//, '') === '.entity-graph.json';
}

function structuredSyncMayChangeEntityGraph(result: unknown): boolean {
  if (!isGitSyncResult(result)) {
    return false;
  }
  if (result.kind === 'ambiguous') {
    return true;
  }
  if (result.kind !== 'paths') {
    return false;
  }

  return result.changes.some((change) => {
    if (change.status === 'renamed') {
      return isEntityGraphSyncPath(change.previousPath) || isEntityGraphSyncPath(change.path);
    }
    return isEntityGraphSyncPath(change.path);
  });
}

export interface CorpusInboundSyncTarget {
  markdownRoot: string;
  corpusStorage: CorpusStorage;
  entityGraphPath(): string;
  notePath(note: string): string;
  wikiPath(slug: string): string;
  sourcePath(source: string): string;
  communityPath(community: string): string;
  principlePath(principle: string): string;
  generatedCommunitySlugs(): ReadonlySet<string>;
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
  withDirectoryMutationLock?<T>(fn: () => Promise<T> | T): Promise<T>;
  recordMutationCommitted(lane: KbIndexMutationLane, reason?: string): void;
  invalidateKbCache(): void;
}

export class CorpusInboundSyncService {
  private readonly options: CorpusInboundSyncServiceOptions;
  constructor(options: CorpusInboundSyncServiceOptions) {
    this.options = options;
  }

  async runInboundSync<T>(fn: () => Promise<T> | T, options: KbInboundSyncOptions = {}): Promise<T> {
    let mutationDiff: InboundSyncMutationDiff | null = null;
    let authoritativeSurface: CorpusSurface | null = null;

    const runWithControllerLock = (): Promise<T> =>
      this.options.mutationLockController.withMutationLock(async (lockContext) => {
        const target = this.options.target;
        const beforeSurface = options.structuredDiff === true ? null : this.buildCurrentSurface();
        const result = await fn();
        if (options.structuredDiff !== true || structuredSyncMayChangeEntityGraph(result)) {
          this.normalizeEntityGraphAfterInboundSync();
        }

        if (options.structuredDiff === true && isGitSyncResult(result)) {
          if (result.kind === 'ambiguous') {
            authoritativeSurface = this.buildCurrentSurface();
            mutationDiff = detectInboundSyncMutationFromSurface(
              authoritativeSurface,
              this.options.manifestAuthority,
              true,
            );
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
            beforeSurface ?? this.buildCurrentSurface(),
            (authoritativeSurface = this.buildCurrentSurface()),
          );
        }

        if (mutationDiff.lane !== null) {
          if (mutationDiff.manifestDeltas.length > 0) {
            this.options.mutationEffects.queueManifestAuthorityDelta(mutationDiff.manifestDeltas);
          } else if (authoritativeSurface !== null) {
            this.options.manifestAuthority.replaceCurrentSurfaceHashes(authoritativeSurface.manifest);
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
    return this.options.withDirectoryMutationLock === undefined
      ? runWithControllerLock()
      : this.options.withDirectoryMutationLock(runWithControllerLock);
  }

  private buildCurrentSurface(): CorpusSurface {
    return buildCorpusSurface(buildCorpusScanView(this.options.target));
  }

  private normalizeEntityGraphAfterInboundSync(): void {
    const target = this.options.target;
    const graph = readEntityGraphFile(target.storagePort, target.entityGraphPath());
    if (graph === null) {
      return;
    }

    const canonicalGraph = consolidateCanonicalEntityGraph(graph);
    if (renderEntityGraph(graph) === renderEntityGraph(canonicalGraph)) {
      return;
    }

    this.options.mutationEffects.writeEntityGraph(canonicalGraph);
  }
}
