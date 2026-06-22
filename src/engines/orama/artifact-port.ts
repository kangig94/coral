import { isNoEntryError } from '../../infra/fs-errors.js';
import { sha256Hex } from '../../infra/hash.js';
import { isRecord } from '../../infra/json.js';
import type {
  EngineArtifactDescriptor,
  EngineArtifactPort,
  EngineArtifactProjectedSnapshot,
} from '../../kb/corpus/artifact-port.js';
import type { KbCorpusSnapshot, KbProjectionArtifactFilePort } from '../../kb/contract.js';
import type { KbDeclaredAnalyzer } from '../../kb/extra-langs.js';
import { ORAMA_SCHEMA } from './schema.js';
import { oramaIndexMetadataPath, oramaIndexPath } from './paths.js';

const ORAMA_PROJECTION_SCHEMA_VERSION = 2;
export const ORAMA_PROJECTION_IDENTITY_SCHEMA_VERSION = 1;
export const ORAMA_INTL_TOKENIZER_IDENTITY = 'intl-baseline';
export const ORAMA_KIWI_TOKENIZER_IDENTITY = 'intl-baseline+kiwi:0.23.0:0.23.0:cong-global';
const ORAMA_DECLARED_ANALYZERS: readonly string[] = [];

export type OramaProjectionIdentityInput = {
  readonly identitySchemaVersion?: number;
  readonly schemaVersion?: number;
  readonly schema?: unknown;
  readonly schemaDigest?: string;
  readonly tokenizerIdentity?: string;
  readonly declaredAnalyzers?: readonly string[];
  readonly nodeVersion?: string;
  readonly icuVersion?: string | null;
};

type NormalizedOramaProjectionIdentityInput = {
  readonly identitySchemaVersion: number;
  readonly schemaVersion: number;
  readonly schema: unknown;
  readonly schemaDigest: string;
  readonly tokenizerIdentity: string;
  readonly declaredAnalyzers: readonly string[];
  readonly nodeVersion: string;
  readonly icuVersion: string | null;
};

function normalizeIdentityAnalyzers(analyzers: readonly string[]): readonly string[] {
  return [...new Set(analyzers.map((analyzer) => analyzer.trim().toLowerCase()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

export function oramaTokenizerIdentityForAnalyzers(analyzers: readonly string[]): string {
  return normalizeIdentityAnalyzers(analyzers).includes('ko')
    ? ORAMA_KIWI_TOKENIZER_IDENTITY
    : ORAMA_INTL_TOKENIZER_IDENTITY;
}

export function createOramaProjectionIdentityInput(
  declaredAnalyzers: readonly string[],
  effectiveAnalyzers: readonly string[] = declaredAnalyzers,
): OramaProjectionIdentityInput {
  return {
    declaredAnalyzers: normalizeIdentityAnalyzers(declaredAnalyzers),
    tokenizerIdentity: oramaTokenizerIdentityForAnalyzers(effectiveAnalyzers),
  };
}

function normalizeProjectionIdentityInput(
  input: OramaProjectionIdentityInput = {},
): NormalizedOramaProjectionIdentityInput {
  const declaredAnalyzers = normalizeIdentityAnalyzers(input.declaredAnalyzers ?? ORAMA_DECLARED_ANALYZERS);
  const schema = input.schema ?? ORAMA_SCHEMA;
  return {
    identitySchemaVersion: input.identitySchemaVersion ?? ORAMA_PROJECTION_IDENTITY_SCHEMA_VERSION,
    schemaVersion: input.schemaVersion ?? ORAMA_PROJECTION_SCHEMA_VERSION,
    schema,
    schemaDigest: input.schemaDigest ?? sha256Hex(JSON.stringify(schema)),
    tokenizerIdentity: input.tokenizerIdentity ?? oramaTokenizerIdentityForAnalyzers(declaredAnalyzers),
    declaredAnalyzers,
    nodeVersion: input.nodeVersion ?? process.versions.node,
    icuVersion: input.icuVersion !== undefined ? input.icuVersion : (process.versions.icu ?? null),
  };
}

export function ORAMA_PROJECTION_IDENTITY_HASH(input: OramaProjectionIdentityInput = {}): string {
  const normalized = normalizeProjectionIdentityInput(input);
  return sha256Hex(
    JSON.stringify({
      identitySchemaVersion: normalized.identitySchemaVersion,
      schemaVersion: normalized.schemaVersion,
      schema: normalized.schema,
      tokenizerIdentity: normalized.tokenizerIdentity,
      declaredAnalyzers: normalized.declaredAnalyzers,
      nodeVersion: normalized.nodeVersion,
      icuVersion: normalized.icuVersion,
    }),
  );
}

export type OramaEntryManifestEntry = {
  readonly documentId: string;
  readonly contentHash: string;
  readonly metadataHash: string;
  readonly kind: 'note' | 'source' | 'community' | 'wiki';
  readonly freshness: 'fresh' | 'stale';
};

export type OramaEntryManifest = Readonly<Record<string, OramaEntryManifestEntry>>;

export type OramaProjectionMetadata = EngineArtifactProjectedSnapshot & {
  readonly identitySchemaVersion?: number;
  readonly schemaVersion?: number;
  readonly schemaDigest?: string;
  readonly nodeVersion?: string;
  readonly icuVersion?: string | null;
  readonly tokenizerIdentity?: string;
  readonly declaredAnalyzers?: readonly string[];
  readonly artifactDigest: string;
  readonly entryManifest: OramaEntryManifest;
};

export type OramaProjectionTokenizerTier = 'intl' | 'kiwi' | 'unknown';
export type OramaProjectionMismatchClassification = 'match' | 'tier-only-upgrade' | 'incompatible';

type OramaArtifactFiles = Pick<KbProjectionArtifactFilePort, 'existsSync' | 'readFileSync'>;

export type OramaProjectionArtifactRead = {
  readonly artifactRaw: string;
  readonly metadata: OramaProjectionMetadata;
};

export type OramaEffectiveDeclaredAnalyzers = (
  declaredAnalyzers: readonly KbDeclaredAnalyzer[],
) => readonly KbDeclaredAnalyzer[];

function isOramaEntryKind(value: unknown): value is OramaEntryManifestEntry['kind'] {
  return value === 'note' || value === 'source' || value === 'community' || value === 'wiki';
}

function isOramaFreshness(value: unknown): value is OramaEntryManifestEntry['freshness'] {
  return value === 'fresh' || value === 'stale';
}

function isOramaEntryManifestEntry(value: unknown): value is OramaEntryManifestEntry {
  return (
    isRecord(value) &&
    typeof value.documentId === 'string' &&
    typeof value.contentHash === 'string' &&
    typeof value.metadataHash === 'string' &&
    isOramaEntryKind(value.kind) &&
    isOramaFreshness(value.freshness)
  );
}

function isOramaEntryManifest(value: unknown): value is OramaEntryManifest {
  if (!isRecord(value)) {
    return false;
  }

  for (const [entryId, entry] of Object.entries(value)) {
    if (entryId.length === 0 || !isOramaEntryManifestEntry(entry)) {
      return false;
    }
  }

  return true;
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function isOptionalStringArray(value: unknown): value is readonly string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
}

function isOramaProjectionMetadata(value: unknown): value is OramaProjectionMetadata {
  return (
    isRecord(value) &&
    typeof value.snapshotId === 'string' &&
    typeof value.contentSeq === 'number' &&
    typeof value.metadataSeq === 'number' &&
    typeof value.contentManifestHash === 'string' &&
    typeof value.metadataManifestHash === 'string' &&
    typeof value.projectionIdentityHash === 'string' &&
    isOptionalNumber(value.identitySchemaVersion) &&
    isOptionalNumber(value.schemaVersion) &&
    isOptionalString(value.schemaDigest) &&
    isOptionalString(value.nodeVersion) &&
    isOptionalNullableString(value.icuVersion) &&
    isOptionalString(value.tokenizerIdentity) &&
    isOptionalStringArray(value.declaredAnalyzers) &&
    typeof value.artifactDigest === 'string' &&
    isOramaEntryManifest(value.entryManifest)
  );
}

export function hasCompleteOramaProjectionIdentityMetadata(
  metadata: OramaProjectionMetadata | undefined,
): metadata is OramaProjectionMetadata &
  Required<
    Pick<
      OramaProjectionMetadata,
      | 'identitySchemaVersion'
      | 'schemaVersion'
      | 'schemaDigest'
      | 'nodeVersion'
      | 'icuVersion'
      | 'tokenizerIdentity'
      | 'declaredAnalyzers'
    >
  > {
  return (
    metadata !== undefined &&
    typeof metadata.identitySchemaVersion === 'number' &&
    typeof metadata.schemaVersion === 'number' &&
    typeof metadata.schemaDigest === 'string' &&
    typeof metadata.nodeVersion === 'string' &&
    (typeof metadata.icuVersion === 'string' || metadata.icuVersion === null) &&
    typeof metadata.tokenizerIdentity === 'string' &&
    Array.isArray(metadata.declaredAnalyzers) &&
    metadata.declaredAnalyzers.every((entry) => typeof entry === 'string')
  );
}

export function oramaProjectionTokenizerTier(
  metadata: OramaProjectionMetadata | undefined,
): OramaProjectionTokenizerTier {
  if (!hasCompleteOramaProjectionIdentityMetadata(metadata)) {
    return 'unknown';
  }
  if (metadata.tokenizerIdentity === ORAMA_KIWI_TOKENIZER_IDENTITY) {
    return 'kiwi';
  }
  if (metadata.tokenizerIdentity === ORAMA_INTL_TOKENIZER_IDENTITY) {
    return 'intl';
  }
  return 'unknown';
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

export function classifyProjectionMismatch(
  persistedMetadata: OramaProjectionMetadata | undefined,
  currentExpectedInput: OramaProjectionIdentityInput = {},
): OramaProjectionMismatchClassification {
  if (!hasCompleteOramaProjectionIdentityMetadata(persistedMetadata)) {
    return 'incompatible';
  }

  const expected = normalizeProjectionIdentityInput(currentExpectedInput);
  const structurallyCompatible =
    persistedMetadata.identitySchemaVersion === expected.identitySchemaVersion &&
    persistedMetadata.schemaVersion === expected.schemaVersion &&
    persistedMetadata.schemaDigest === expected.schemaDigest &&
    persistedMetadata.nodeVersion === expected.nodeVersion &&
    persistedMetadata.icuVersion === expected.icuVersion;

  if (!structurallyCompatible) {
    return 'incompatible';
  }

  const tokenizerMatches = persistedMetadata.tokenizerIdentity === expected.tokenizerIdentity;
  const declaredAnalyzersMatch = stringArraysEqual(persistedMetadata.declaredAnalyzers, expected.declaredAnalyzers);
  if (tokenizerMatches && declaredAnalyzersMatch) {
    return 'match';
  }

  if (
    oramaProjectionTokenizerTier(persistedMetadata) === 'intl' &&
    expected.tokenizerIdentity === ORAMA_KIWI_TOKENIZER_IDENTITY
  ) {
    return 'tier-only-upgrade';
  }

  return 'incompatible';
}

export function createOramaProjectionMetadata(
  snapshot: KbCorpusSnapshot,
  artifactDigest: string,
  entryManifest: OramaEntryManifest,
  identityInput: OramaProjectionIdentityInput = {},
): OramaProjectionMetadata {
  const normalizedIdentity = normalizeProjectionIdentityInput(identityInput);
  return {
    snapshotId: snapshot.snapshotId,
    contentSeq: snapshot.contentSeq,
    metadataSeq: snapshot.metadataSeq,
    contentManifestHash: snapshot.contentManifestHash,
    metadataManifestHash: snapshot.metadataManifestHash,
    projectionIdentityHash: ORAMA_PROJECTION_IDENTITY_HASH(normalizedIdentity),
    identitySchemaVersion: normalizedIdentity.identitySchemaVersion,
    schemaVersion: normalizedIdentity.schemaVersion,
    schemaDigest: normalizedIdentity.schemaDigest,
    nodeVersion: normalizedIdentity.nodeVersion,
    icuVersion: normalizedIdentity.icuVersion,
    tokenizerIdentity: normalizedIdentity.tokenizerIdentity,
    declaredAnalyzers: normalizedIdentity.declaredAnalyzers,
    artifactDigest,
    entryManifest,
  };
}

export function computeOramaArtifactDigest(serializedArtifact: string): string {
  return sha256Hex(serializedArtifact);
}

function readDocumentId(document: Record<string, unknown>): string | null {
  const id = document.id;
  return typeof id === 'string' ? id : null;
}

function readEntryId(document: Record<string, unknown>): string | null {
  const entryId = document.entryId;
  return typeof entryId === 'string' ? entryId : null;
}

function readContentHash(document: Record<string, unknown>): string | null {
  const contentHash = document.contentHash;
  return typeof contentHash === 'string' ? contentHash : null;
}

function readMetadataHash(document: Record<string, unknown>): string | null {
  const metadataHash = document.metadataHash;
  return typeof metadataHash === 'string' ? metadataHash : null;
}

export function createOramaEntryManifestFromArtifact(artifact: unknown): OramaEntryManifest {
  if (!isRecord(artifact) || !isRecord(artifact.docs) || !isRecord(artifact.docs.docs)) {
    throw new Error('projection artifact is missing the Orama document store');
  }

  const manifest: Record<string, OramaEntryManifestEntry> = {};
  for (const document of Object.values(artifact.docs.docs)) {
    if (!isRecord(document)) {
      throw new Error('projection artifact document store contains a malformed document');
    }

    const entryId = readEntryId(document);
    const documentId = readDocumentId(document);
    const contentHash = readContentHash(document);
    const metadataHash = readMetadataHash(document);
    const { kind, freshness } = document;
    if (
      entryId === null ||
      documentId === null ||
      contentHash === null ||
      metadataHash === null ||
      !isOramaEntryKind(kind) ||
      !isOramaFreshness(freshness)
    ) {
      throw new Error('projection artifact document store contains a document missing manifest fields');
    }

    manifest[entryId] = {
      documentId,
      contentHash,
      metadataHash,
      kind,
      freshness,
    };
  }

  return manifest;
}

export function readOramaProjectionArtifact(
  files: OramaArtifactFiles,
  artifactPath: string,
  metadataPath: string,
): OramaProjectionArtifactRead {
  const artifactRaw = files.readFileSync(artifactPath, 'utf-8');
  const metadata = readOramaProjectionMetadata(files, metadataPath);

  const artifactDigest = computeOramaArtifactDigest(artifactRaw);
  if (metadata.artifactDigest !== artifactDigest) {
    throw new Error('projection artifact digest does not match metadata sidecar');
  }

  return { artifactRaw, metadata };
}

export function readOramaProjectionMetadata(files: OramaArtifactFiles, metadataPath: string): OramaProjectionMetadata {
  const metadata = JSON.parse(files.readFileSync(metadataPath, 'utf-8')) as unknown;
  if (!isOramaProjectionMetadata(metadata)) {
    throw new Error('projection metadata sidecar is missing required identity or manifest fields');
  }

  return metadata;
}

export class OramaArtifactPort implements EngineArtifactPort {
  constructor(
    private readonly files: OramaArtifactFiles,
    private readonly runtimeDir: string,
    private readonly declaredAnalyzers: readonly KbDeclaredAnalyzer[],
    private readonly effectiveDeclaredAnalyzers: OramaEffectiveDeclaredAnalyzers = (declaredAnalyzers) =>
      declaredAnalyzers,
  ) {}

  private projectionIdentityHash(): string {
    return ORAMA_PROJECTION_IDENTITY_HASH(
      createOramaProjectionIdentityInput(
        this.declaredAnalyzers,
        this.effectiveDeclaredAnalyzers(this.declaredAnalyzers),
      ),
    );
  }

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
        expectedProjectionIdentityHash: this.projectionIdentityHash(),
        freshness,
      },
    ];
  }

  private readPresentFreshness(artifactPath: string, metadataPath: string): EngineArtifactDescriptor['freshness'] {
    try {
      const { metadata } = readOramaProjectionArtifact(this.files, artifactPath, metadataPath);
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

export function createOramaArtifactPort(
  files: OramaArtifactFiles,
  runtimeDir: string,
  declaredAnalyzers: readonly KbDeclaredAnalyzer[],
  effectiveDeclaredAnalyzers?: OramaEffectiveDeclaredAnalyzers,
): OramaArtifactPort {
  return new OramaArtifactPort(files, runtimeDir, declaredAnalyzers, effectiveDeclaredAnalyzers);
}
