import { errorMessage } from '../../infra/error-format.js';
import { isRecord } from '../../infra/json.js';
import type {
  EngineArtifactDescriptor,
  EngineArtifactPort,
  EngineArtifactProjectedSnapshot,
} from '../../kb/corpus/artifact-port.js';
import type { KbEngineRuntime, KbProjectionArtifactFilePort } from '../../kb/contract.js';
import { NEEDLE_CONSUMER_ID, type NeedleBackendOptions } from './contract.js';
import {
  needleActivePointerPath,
  needleSnapshotDbPath,
  needleSnapshotDir,
  needleSnapshotManifestPath,
} from './paths.js';
import { createNeedleStore, isNeedleAddonCompatible, type NeedleStore } from './store.js';

type NeedleArtifactFiles = Pick<KbProjectionArtifactFilePort, 'existsSync' | 'readFileSync'>;

type NeedleSnapshotManifest = {
  readonly snapshot: EngineArtifactProjectedSnapshot;
  readonly specId: string;
  readonly entryCount: number;
  readonly chunkCount: number;
};

type NeedleArtifactPortOptions = {
  readonly addonPath: string;
  readonly expectedProjectionIdentityHash: string;
  readonly pluginRoot?: string;
  readonly storeFactory?: NeedleBackendOptions['storeFactory'];
};

function isNeedleSnapshotManifest(value: unknown): value is NeedleSnapshotManifest {
  return (
    isRecord(value) &&
    isRecord(value.snapshot) &&
    typeof value.snapshot.snapshotId === 'string' &&
    typeof value.snapshot.contentSeq === 'number' &&
    typeof value.snapshot.metadataSeq === 'number' &&
    typeof value.snapshot.contentManifestHash === 'string' &&
    typeof value.snapshot.metadataManifestHash === 'string' &&
    typeof value.snapshot.projectionIdentityHash === 'string' &&
    typeof value.specId === 'string' &&
    typeof value.entryCount === 'number' &&
    typeof value.chunkCount === 'number'
  );
}

export class NeedleArtifactPort implements EngineArtifactPort {
  constructor(
    private readonly runtime: Pick<KbEngineRuntime, 'runtimeDir'>,
    private readonly files: NeedleArtifactFiles,
    private readonly options: NeedleArtifactPortOptions,
  ) {}

  async describeArtifacts(): Promise<readonly EngineArtifactDescriptor[]> {
    const activePointerPath = needleActivePointerPath(this.runtime.runtimeDir);
    const described = await this.describeFreshness(activePointerPath);

    return [
      {
        artifactId: `${NEEDLE_CONSUMER_ID}:projection-cache`,
        kind: 'projection-cache',
        targetConsumerIds: [],
        corpusInterest: 'content',
        artifactPaths: described.artifactPaths,
        expectedProjectionIdentityHash: this.options.expectedProjectionIdentityHash,
        freshness: described.freshness,
      },
    ];
  }

  private async describeFreshness(activePointerPath: string): Promise<{
    readonly artifactPaths: readonly string[];
    readonly freshness: EngineArtifactDescriptor['freshness'];
  }> {
    if (!this.files.existsSync(activePointerPath)) {
      return { artifactPaths: [activePointerPath], freshness: { status: 'missing' } };
    }

    let snapshotId: string;
    try {
      snapshotId = this.files.readFileSync(activePointerPath, 'utf-8').trim();
    } catch (error: unknown) {
      return {
        artifactPaths: [activePointerPath],
        freshness: { status: 'corrupt', diagnostic: `projection active pointer is unreadable: ${errorMessage(error)}` },
      };
    }

    if (snapshotId.length === 0) {
      return {
        artifactPaths: [activePointerPath],
        freshness: { status: 'corrupt', diagnostic: 'projection active pointer is empty' },
      };
    }

    const snapshotDir = needleSnapshotDir(this.runtime.runtimeDir, snapshotId);
    const manifestPath = needleSnapshotManifestPath(needleSnapshotDir(this.runtime.runtimeDir, snapshotId));
    const storePath = needleSnapshotDbPath(this.runtime.runtimeDir, snapshotId);
    const artifactPaths = [activePointerPath, manifestPath, storePath];
    if (
      !this.files.existsSync(snapshotDir) ||
      !this.files.existsSync(manifestPath) ||
      !this.files.existsSync(storePath)
    ) {
      return {
        artifactPaths,
        freshness: { status: 'corrupt', diagnostic: 'active projection snapshot is incomplete' },
      };
    }

    let manifest: NeedleSnapshotManifest;
    try {
      const parsed = JSON.parse(this.files.readFileSync(manifestPath, 'utf-8')) as unknown;
      if (!isNeedleSnapshotManifest(parsed)) {
        return {
          artifactPaths,
          freshness: { status: 'corrupt', diagnostic: 'projection manifest is missing required identity fields' },
        };
      }
      manifest = parsed;
    } catch (error: unknown) {
      return {
        artifactPaths,
        freshness: { status: 'corrupt', diagnostic: `projection manifest is unreadable: ${errorMessage(error)}` },
      };
    }

    const nativeState = await this.readNativeState(storePath);
    if (nativeState.status === 'corrupt') {
      return { artifactPaths, freshness: nativeState };
    }
    if (nativeState.specId !== manifest.specId) {
      return {
        artifactPaths,
        freshness: {
          status: 'corrupt',
          diagnostic: 'projection manifest specId does not match the native store',
        },
      };
    }

    return {
      artifactPaths,
      freshness: {
        status: 'present',
        projected: manifest.snapshot,
      },
    };
  }

  private async readNativeState(
    storePath: string,
  ): Promise<
    | { readonly status: 'present'; readonly specId: string | null }
    | { readonly status: 'corrupt'; readonly diagnostic: string }
  > {
    let store: NeedleStore | null = null;
    try {
      store =
        this.options.storeFactory?.(this.runtime.runtimeDir) ??
        createNeedleStore({
          runtimeDir: this.runtime.runtimeDir,
          addonPath: this.options.addonPath,
          ...(this.options.pluginRoot === undefined ? {} : { pluginRoot: this.options.pluginRoot }),
        });
      if (store === null) {
        return { status: 'corrupt', diagnostic: 'projection native store is unavailable' };
      }
      await store.init(storePath);
      const stats = await store.stats();
      if (!isNeedleAddonCompatible(stats)) {
        return { status: 'corrupt', diagnostic: 'projection native store is incompatible' };
      }
      return { status: 'present', specId: (await store.getActiveSpec())?.specId ?? null };
    } catch (error: unknown) {
      return { status: 'corrupt', diagnostic: `projection native store is unreadable: ${errorMessage(error)}` };
    } finally {
      await store?.close().catch(() => {});
    }
  }
}

export function createNeedleArtifactPort(
  runtime: Pick<KbEngineRuntime, 'runtimeDir'>,
  files: NeedleArtifactFiles,
  options: NeedleArtifactPortOptions,
): NeedleArtifactPort {
  return new NeedleArtifactPort(runtime, files, options);
}
