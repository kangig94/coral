import { isNoEntryError } from '../../infra/fs-errors.js';
import { sha256Hex } from '../../infra/hash.js';
import { isRecord } from '../../infra/json.js';
import type {
  EngineArtifactDescriptor,
  EngineArtifactPort,
  EngineArtifactProjectedSnapshot,
} from '../../kb/corpus/artifact-port.js';
import type { KbCorpusSnapshot, KbProjectionArtifactFilePort } from '../../kb/contract.js';
import { ORAMA_SCHEMA } from './schema.js';
import { oramaIndexMetadataPath, oramaIndexPath } from './paths.js';

const ORAMA_PROJECTION_SCHEMA_VERSION = 1;

export const ORAMA_PROJECTION_IDENTITY_HASH = sha256Hex(
  JSON.stringify({
    schemaVersion: ORAMA_PROJECTION_SCHEMA_VERSION,
    schema: ORAMA_SCHEMA,
  }),
);

export type OramaProjectionMetadata = EngineArtifactProjectedSnapshot & {
  readonly artifactDigest: string;
};

type OramaArtifactFiles = Pick<KbProjectionArtifactFilePort, 'existsSync' | 'readFileSync'>;

function isOramaProjectionMetadata(value: unknown): value is OramaProjectionMetadata {
  return (
    isRecord(value) &&
    typeof value.snapshotId === 'string' &&
    typeof value.contentSeq === 'number' &&
    typeof value.metadataSeq === 'number' &&
    typeof value.contentManifestHash === 'string' &&
    typeof value.metadataManifestHash === 'string' &&
    typeof value.projectionIdentityHash === 'string' &&
    typeof value.artifactDigest === 'string'
  );
}

export function createOramaProjectionMetadata(
  snapshot: KbCorpusSnapshot,
  artifactDigest: string,
): OramaProjectionMetadata {
  return {
    snapshotId: snapshot.snapshotId,
    contentSeq: snapshot.contentSeq,
    metadataSeq: snapshot.metadataSeq,
    contentManifestHash: snapshot.contentManifestHash,
    metadataManifestHash: snapshot.metadataManifestHash,
    projectionIdentityHash: ORAMA_PROJECTION_IDENTITY_HASH,
    artifactDigest,
  };
}

export function computeOramaArtifactDigest(serializedArtifact: string): string {
  return sha256Hex(serializedArtifact);
}

export class OramaArtifactPort implements EngineArtifactPort {
  constructor(
    private readonly files: OramaArtifactFiles,
    private readonly runtimeDir: string,
  ) {}

  async describeArtifacts(): Promise<readonly EngineArtifactDescriptor[]> {
    const artifactPath = oramaIndexPath(this.runtimeDir);
    const metadataPath = oramaIndexMetadataPath(this.runtimeDir);
    const artifactExists = this.files.existsSync(artifactPath);
    const metadataExists = this.files.existsSync(metadataPath);

    let freshness: EngineArtifactDescriptor['freshness'];
    if (!artifactExists && !metadataExists) {
      freshness = { status: 'missing' };
    } else if (!artifactExists && metadataExists) {
      freshness = { status: 'corrupt', diagnostic: 'projection metadata exists without the projection artifact' };
    } else if (artifactExists && !metadataExists) {
      freshness = { status: 'corrupt', diagnostic: 'projection metadata sidecar is missing' };
    } else {
      freshness = this.readPresentFreshness(artifactPath, metadataPath);
    }

    return [
      {
        artifactId: 'orama:projection-cache',
        kind: 'projection-cache',
        targetConsumerIds: [],
        corpusInterest: 'both',
        artifactPaths: [artifactPath, metadataPath],
        expectedProjectionIdentityHash: ORAMA_PROJECTION_IDENTITY_HASH,
        freshness,
      },
    ];
  }

  private readPresentFreshness(artifactPath: string, metadataPath: string): EngineArtifactDescriptor['freshness'] {
    try {
      const artifactRaw = this.files.readFileSync(artifactPath, 'utf-8');
      const metadata = JSON.parse(this.files.readFileSync(metadataPath, 'utf-8')) as unknown;
      if (!isOramaProjectionMetadata(metadata)) {
        return { status: 'corrupt', diagnostic: 'projection metadata sidecar is missing required identity fields' };
      }
      const artifactDigest = computeOramaArtifactDigest(artifactRaw);
      if (metadata.artifactDigest !== artifactDigest) {
        return { status: 'corrupt', diagnostic: 'projection artifact digest does not match metadata sidecar' };
      }
      return {
        status: 'present',
        projected: {
          snapshotId: metadata.snapshotId,
          contentSeq: metadata.contentSeq,
          metadataSeq: metadata.metadataSeq,
          contentManifestHash: metadata.contentManifestHash,
          metadataManifestHash: metadata.metadataManifestHash,
          projectionIdentityHash: metadata.projectionIdentityHash,
        },
      };
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return { status: 'missing' };
      }
      const diagnostic = error instanceof Error ? error.message : 'projection artifact could not be read';
      return { status: 'corrupt', diagnostic };
    }
  }
}

export function createOramaArtifactPort(files: OramaArtifactFiles, runtimeDir: string): OramaArtifactPort {
  return new OramaArtifactPort(files, runtimeDir);
}
