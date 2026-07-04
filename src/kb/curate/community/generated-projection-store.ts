import { join } from 'node:path';

import yaml from 'yaml';

import { isNoEntryError } from '../../../infra/fs-errors.js';
import { isRecord } from '../../../infra/json.js';
import type { StoragePort, TimePort } from '../../../infra/port-types.js';
import type { IdPort } from '../../../runtime/ports.js';
import type { KbCorpusSnapshot } from '../../contract.js';
import {
  extractBody,
  extractTitle,
  parseCommunityFrontmatter,
  parseMembersFromBody,
  parseSummaryFromBody,
} from '../../corpus/frontmatter.js';
import { writeFileAtomic } from '../../corpus/file-atomic.js';
import { computeManifestHashFromSurfaceHashes } from '../../corpus/manifest-authority.js';
import { computeMetadataSurfaceHash } from '../../corpus/snapshot.js';
import type { KbReindexCommunityRecord } from '../../entry-types.js';
import type { CorpusMarkdownFileScan } from '../../corpus/rescan/scan.js';
import type { CommunityDocument, DetectedCommunity, ExistingGeneratedCommunity } from './contracts.js';

const STORE_SCHEMA_VERSION = 1;
const STORE_DIR = 'generated-community-projection';
const ACTIVE_POINTER_FILE = 'active-generation.json';
const GENERATIONS_DIR = 'generations';
const STAGING_DIR = 'staging';
const MANIFEST_FILE = 'manifest.json';
const GENERATED_COMMUNITY_MARKER = 'coralGeneratedCommunity';

type StoreFiles = Pick<
  StoragePort,
  'existsSync' | 'readFileSync' | 'writeFileSync' | 'mkdirSync' | 'renameSync' | 'rmSync' | 'readdirSync'
>;

type StoreHost = {
  readonly storagePort: Pick<StoragePort, 'mkdirSync' | 'writeFileSync' | 'renameSync' | 'rmSync'>;
  readonly ids: Pick<IdPort, 'uuid'>;
};

export type GeneratedCommunityFreshness = {
  readonly generatedCommunityGeneration: number;
  readonly generatedCommunityDocsHash: string;
};

type GeneratedCommunityGenerationSnapshot = GeneratedCommunityFreshness & {
  readonly generationId: string;
  readonly topologyHash: string;
  readonly snapshot: KbCorpusSnapshot | null;
};

export type GeneratedCommunityDocumentRecord = {
  readonly slug: string;
  readonly title: string;
  readonly level: number;
  readonly members: readonly string[];
  readonly parent?: string;
  readonly children?: readonly string[];
  readonly summary?: string;
  readonly summaryInputFingerprint?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly content: string;
  readonly contentHash: string;
  readonly topologyHash: string;
  readonly generation: number;
  readonly generationId: string;
  readonly generationDocsHash: string;
  readonly parentSnapshotId: string;
  readonly parentContentSeq: number;
  readonly parentMetadataSeq: number;
  readonly priorGeneration: number;
};

export type GeneratedCommunityActiveGeneration = GeneratedCommunityGenerationSnapshot & {
  readonly records: readonly GeneratedCommunityDocumentRecord[];
};

export type GeneratedCommunityProjectionCandidate = {
  readonly stagingId: string;
  readonly stagingDir: string;
  readonly generation: number;
  readonly generationId: string;
  readonly topologyHash: string;
  readonly generationDocsHash: string;
  readonly snapshot: KbCorpusSnapshot;
  readonly priorGeneration: number;
  readonly records: readonly GeneratedCommunityDocumentRecord[];
};

export type GeneratedCommunityAdoptResult =
  | {
      readonly status: 'adopted';
      readonly generation: number;
      readonly generatedCommunityDocsHash: string;
    }
  | {
      readonly status: 'discarded';
      readonly reason: 'stale_snapshot' | 'stale_generated_generation';
      readonly generation: number;
      readonly currentSnapshot: KbCorpusSnapshot;
      readonly priorGeneration: number;
      readonly currentGeneration: number;
    };

export type AuthoredCommunityDocument = {
  readonly slug: string;
  readonly content: string;
};

type CommunityRawDocument = AuthoredCommunityDocument & {
  readonly authority: 'authored' | 'generated';
};

export type CommunityDocumentProvider = {
  readonly authored: readonly AuthoredCommunityDocument[];
  readonly generated: readonly GeneratedCommunityDocumentRecord[];
  readonly rawDocuments: readonly CommunityRawDocument[];
  readonly freshness: GeneratedCommunityFreshness;
  readRawDocument(slug: string): CommunityRawDocument | null;
};

export type ExistingCommunityState = {
  readonly generated: ExistingGeneratedCommunity[];
  readonly reservedSlugs: Set<string>;
  readonly authoredDocuments: AuthoredCommunityDocument[];
  readonly migratedGeneratedSlugs: Set<string>;
};

type StoredManifest = {
  readonly schemaVersion: number;
  readonly generation: number;
  readonly generationId: string;
  readonly topologyHash: string;
  readonly generationDocsHash: string;
  readonly snapshot: KbCorpusSnapshot;
  readonly priorGeneration: number;
  readonly records: readonly GeneratedCommunityDocumentRecord[];
};

type ActivePointer = {
  readonly schemaVersion: number;
  readonly generation: number;
  readonly generationId: string;
  readonly topologyHash: string;
  readonly generationDocsHash: string;
  readonly snapshot: KbCorpusSnapshot;
};

type GenerationPointer = ActivePointer & {
  readonly records: readonly GeneratedCommunityDocumentRecord[];
};

const EMPTY_GENERATED_COMMUNITY_DOCS_HASH = computeManifestHashFromSurfaceHashes(new Map());
export const EMPTY_GENERATED_COMMUNITY_FRESHNESS: GeneratedCommunityFreshness = {
  generatedCommunityGeneration: 0,
  generatedCommunityDocsHash: EMPTY_GENERATED_COMMUNITY_DOCS_HASH,
};

function generationSnapshotFromPointer(pointer: GenerationPointer | null): GeneratedCommunityActiveGeneration {
  if (pointer === null) {
    return {
      generationId: 'none',
      topologyHash: EMPTY_GENERATED_COMMUNITY_DOCS_HASH,
      snapshot: null,
      generatedCommunityGeneration: 0,
      generatedCommunityDocsHash: EMPTY_GENERATED_COMMUNITY_DOCS_HASH,
      records: [],
    };
  }
  return {
    generationId: pointer.generationId,
    topologyHash: pointer.topologyHash,
    snapshot: pointer.snapshot,
    generatedCommunityGeneration: pointer.generation,
    generatedCommunityDocsHash: pointer.generationDocsHash,
    records: pointer.records,
  };
}

function sameSnapshot(left: KbCorpusSnapshot, right: KbCorpusSnapshot): boolean {
  return (
    left.snapshotId === right.snapshotId &&
    left.contentSeq === right.contentSeq &&
    left.metadataSeq === right.metadataSeq &&
    left.contentManifestHash === right.contentManifestHash &&
    left.metadataManifestHash === right.metadataManifestHash
  );
}

function maybeReadonlyStringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined;
}

function isKbCorpusSnapshot(value: unknown): value is KbCorpusSnapshot {
  return (
    isRecord(value) &&
    typeof value.snapshotId === 'string' &&
    typeof value.contentSeq === 'number' &&
    typeof value.metadataSeq === 'number' &&
    typeof value.contentManifestHash === 'string' &&
    typeof value.metadataManifestHash === 'string'
  );
}

function isGeneratedRecord(value: unknown): value is GeneratedCommunityDocumentRecord {
  return (
    isRecord(value) &&
    typeof value.slug === 'string' &&
    typeof value.title === 'string' &&
    typeof value.level === 'number' &&
    Array.isArray(value.members) &&
    value.members.every((entry) => typeof entry === 'string') &&
    maybeReadonlyStringArray(value.children) === value.children &&
    (value.parent === undefined || typeof value.parent === 'string') &&
    (value.summary === undefined || typeof value.summary === 'string') &&
    (value.summaryInputFingerprint === undefined || typeof value.summaryInputFingerprint === 'string') &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.content === 'string' &&
    typeof value.contentHash === 'string' &&
    typeof value.topologyHash === 'string' &&
    typeof value.generation === 'number' &&
    typeof value.generationId === 'string' &&
    typeof value.generationDocsHash === 'string' &&
    typeof value.parentSnapshotId === 'string' &&
    typeof value.parentContentSeq === 'number' &&
    typeof value.parentMetadataSeq === 'number' &&
    typeof value.priorGeneration === 'number'
  );
}

function isStoredManifest(value: unknown): value is StoredManifest {
  return (
    isRecord(value) &&
    value.schemaVersion === STORE_SCHEMA_VERSION &&
    typeof value.generation === 'number' &&
    typeof value.generationId === 'string' &&
    typeof value.topologyHash === 'string' &&
    typeof value.generationDocsHash === 'string' &&
    isKbCorpusSnapshot(value.snapshot) &&
    typeof value.priorGeneration === 'number' &&
    Array.isArray(value.records) &&
    value.records.every(isGeneratedRecord)
  );
}

function isActivePointer(value: unknown): value is ActivePointer {
  return (
    isRecord(value) &&
    value.schemaVersion === STORE_SCHEMA_VERSION &&
    typeof value.generation === 'number' &&
    typeof value.generationId === 'string' &&
    typeof value.topologyHash === 'string' &&
    typeof value.generationDocsHash === 'string' &&
    isKbCorpusSnapshot(value.snapshot)
  );
}

function readYamlFrontmatterRecord(raw: string): Record<string, unknown> | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (match === null) {
    return null;
  }
  try {
    const parsed = yaml.parse(match[1] ?? '') as unknown;
    return parsed === null ? {} : isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasExplicitGeneratedMarker(raw: string): boolean {
  const record = readYamlFrontmatterRecord(raw);
  return record?.[GENERATED_COMMUNITY_MARKER] === true || record?.generatedCommunity === true;
}

function parseExistingGeneratedCommunity(slug: string, raw: string): ExistingGeneratedCommunity | null {
  try {
    const frontmatter = parseCommunityFrontmatter(raw);
    const body = extractBody(raw);
    return {
      slug,
      title: extractTitle(raw),
      level: frontmatter.level,
      members: parseMembersFromBody(body),
      ...(frontmatter.parent === undefined ? {} : { parent: frontmatter.parent }),
      ...(frontmatter.children === undefined ? {} : { children: frontmatter.children }),
      summary: parseSummaryFromBody(body),
      ...(frontmatter.summaryInputFingerprint === undefined
        ? {}
        : { summaryInputFingerprint: frontmatter.summaryInputFingerprint }),
      createdAt: frontmatter.createdAt,
      updatedAt: frontmatter.updatedAt,
    };
  } catch {
    return null;
  }
}

function legacyGeneratedSignatureMatches(slug: string, raw: string, detectedSlugs: ReadonlySet<string>): boolean {
  if (!detectedSlugs.has(slug)) {
    return false;
  }
  const parsed = parseExistingGeneratedCommunity(slug, raw);
  if (parsed === null) {
    return false;
  }
  const normalizedBody = extractBody(raw).replace(/\r\n/g, '\n').trim();
  const expectedMembers = ['## Members', '', ...parsed.members.map((member) => `- #${member}`)].join('\n');
  if (!normalizedBody.includes(expectedMembers)) {
    return false;
  }
  if (parsed.children !== undefined && parsed.children.length > 0) {
    const expectedChildren = ['## Children', '', ...parsed.children.map((child) => `- ${child}`)].join('\n');
    if (!normalizedBody.includes(expectedChildren)) {
      return false;
    }
  }
  return true;
}

function classifyCorpusCommunityDocument(input: {
  readonly slug: string;
  readonly raw: string;
  readonly detectedGeneratedSlugs: ReadonlySet<string>;
}): 'generated' | 'authored-reserved' {
  if (hasExplicitGeneratedMarker(input.raw)) {
    return 'generated';
  }
  if (legacyGeneratedSignatureMatches(input.slug, input.raw, input.detectedGeneratedSlugs)) {
    return 'generated';
  }
  return 'authored-reserved';
}

function computeGenerationDocsHash(
  records: readonly Pick<GeneratedCommunityDocumentRecord, 'slug' | 'content'>[],
): string {
  const hashes = new Map<string, string>();
  for (const record of [...records].sort((left, right) => left.slug.localeCompare(right.slug))) {
    hashes.set(`generated-community:${record.slug}`, computeMetadataSurfaceHash({ rawBytes: record.content }));
  }
  return computeManifestHashFromSurfaceHashes(hashes);
}

export function generatedCommunityRecordToReindexRecord(
  record: GeneratedCommunityDocumentRecord,
): KbReindexCommunityRecord {
  return {
    slug: record.slug,
    path: `generated-communities/${record.slug}.md`,
    title: record.title,
    body: extractBody(record.content),
    level: record.level,
    members: [...record.members],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.parent === undefined ? {} : { parent: record.parent }),
    ...(record.children === undefined ? {} : { children: [...record.children] }),
    ...(record.summary === undefined ? {} : { summary: record.summary }),
    ...(record.summaryInputFingerprint === undefined
      ? {}
      : { summaryInputFingerprint: record.summaryInputFingerprint }),
  };
}

export class GeneratedCommunityProjectionStore {
  private readonly rootDir: string;
  private readonly files: StoreFiles;
  private readonly host: StoreHost;
  private readonly time: Pick<TimePort, 'now'>;

  constructor(options: {
    readonly runtimeDir: string;
    readonly storage: StoreFiles;
    readonly ids: Pick<IdPort, 'uuid'>;
    readonly time: Pick<TimePort, 'now'>;
  }) {
    this.rootDir = join(options.runtimeDir, STORE_DIR);
    this.files = options.storage;
    this.host = { storagePort: options.storage, ids: options.ids };
    this.time = options.time;
  }

  readActiveGeneration(): GeneratedCommunityActiveGeneration {
    return generationSnapshotFromPointer(this.readActivePointerWithRecords());
  }

  readActiveFreshness(): GeneratedCommunityFreshness {
    const active = this.readActiveGeneration();
    return {
      generatedCommunityGeneration: active.generatedCommunityGeneration,
      generatedCommunityDocsHash: active.generatedCommunityDocsHash,
    };
  }

  readActiveGeneratedSlugs(): ReadonlySet<string> {
    return new Set(this.readActiveGeneration().records.map((record) => record.slug));
  }

  readCommunityDocument(slug: string): GeneratedCommunityDocumentRecord | null {
    return this.readActiveGeneration().records.find((record) => record.slug === slug) ?? null;
  }

  createProvider(authored: readonly AuthoredCommunityDocument[]): CommunityDocumentProvider {
    const active = this.readActiveGeneration();
    const rawDocuments: CommunityRawDocument[] = [
      ...authored.map((document) => ({ ...document, authority: 'authored' as const })),
      ...active.records.map((record) => ({
        slug: record.slug,
        content: record.content,
        authority: 'generated' as const,
      })),
    ];
    return {
      authored: [...authored],
      generated: active.records,
      rawDocuments,
      freshness: {
        generatedCommunityGeneration: active.generatedCommunityGeneration,
        generatedCommunityDocsHash: active.generatedCommunityDocsHash,
      },
      readRawDocument: (slug) => rawDocuments.find((document) => document.slug === slug) ?? null,
    };
  }

  loadExistingCommunityState(input: {
    readonly communityFiles: readonly Pick<CorpusMarkdownFileScan, 'slug' | 'content'>[];
    readonly detectedCommunities: readonly Pick<DetectedCommunity, 'slug'>[];
  }): ExistingCommunityState {
    const active = this.readActiveGeneration();
    const generatedBySlug = new Map<string, ExistingGeneratedCommunity>();
    for (const record of active.records) {
      generatedBySlug.set(record.slug, {
        slug: record.slug,
        title: record.title,
        level: record.level,
        members: [...record.members],
        ...(record.parent === undefined ? {} : { parent: record.parent }),
        ...(record.children === undefined ? {} : { children: [...record.children] }),
        ...(record.summary === undefined ? {} : { summary: record.summary }),
        ...(record.summaryInputFingerprint === undefined
          ? {}
          : { summaryInputFingerprint: record.summaryInputFingerprint }),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    }

    const detectedSlugs = new Set(input.detectedCommunities.map((community) => community.slug));
    const reservedSlugs = new Set<string>();
    const authoredDocuments: AuthoredCommunityDocument[] = [];
    const migratedGeneratedSlugs = new Set<string>();
    for (const file of input.communityFiles) {
      const classification = classifyCorpusCommunityDocument({
        slug: file.slug,
        raw: file.content,
        detectedGeneratedSlugs: detectedSlugs,
      });
      if (classification === 'generated') {
        migratedGeneratedSlugs.add(file.slug);
        const parsed = parseExistingGeneratedCommunity(file.slug, file.content);
        if (parsed !== null && !generatedBySlug.has(file.slug)) {
          generatedBySlug.set(file.slug, parsed);
        }
        continue;
      }

      reservedSlugs.add(file.slug);
      generatedBySlug.delete(file.slug);
      authoredDocuments.push({ slug: file.slug, content: file.content });
    }

    return {
      generated: [...generatedBySlug.values()],
      reservedSlugs,
      authoredDocuments,
      migratedGeneratedSlugs,
    };
  }

  stageGeneration(input: {
    readonly snapshot: KbCorpusSnapshot;
    readonly topologyHash: string;
    readonly documents: readonly CommunityDocument[];
  }): GeneratedCommunityProjectionCandidate {
    const active = this.readActiveGeneration();
    const generation = active.generatedCommunityGeneration + 1;
    const generationId = `${generation}-${this.host.ids.uuid()}`;
    const stagingId = this.host.ids.uuid();
    const stagingDir = join(this.rootDir, STAGING_DIR, stagingId);
    const generationDocsHash = computeGenerationDocsHash(input.documents);
    const records: GeneratedCommunityDocumentRecord[] = [];
    for (const document of input.documents) {
      records.push({
        slug: document.slug,
        title: document.title,
        level: document.level,
        members: [...document.members],
        ...(document.parent === undefined ? {} : { parent: document.parent }),
        ...(document.children === undefined ? {} : { children: [...document.children] }),
        ...(document.summary === undefined ? {} : { summary: document.summary }),
        ...(document.summaryInputFingerprint === undefined
          ? {}
          : { summaryInputFingerprint: document.summaryInputFingerprint }),
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
        content: document.content,
        contentHash: computeMetadataSurfaceHash({ rawBytes: document.content }),
        topologyHash: input.topologyHash,
        generation,
        generationId,
        generationDocsHash,
        parentSnapshotId: input.snapshot.snapshotId,
        parentContentSeq: input.snapshot.contentSeq,
        parentMetadataSeq: input.snapshot.metadataSeq,
        priorGeneration: active.generatedCommunityGeneration,
      });
    }

    this.files.rmSync(stagingDir, { recursive: true, force: true });
    this.files.mkdirSync(stagingDir, { recursive: true });
    const manifest: StoredManifest = {
      schemaVersion: STORE_SCHEMA_VERSION,
      generation,
      generationId,
      topologyHash: input.topologyHash,
      generationDocsHash,
      snapshot: input.snapshot,
      priorGeneration: active.generatedCommunityGeneration,
      records,
    };
    writeFileAtomic(this.host, join(stagingDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);

    return {
      stagingId,
      stagingDir,
      generation,
      generationId,
      topologyHash: input.topologyHash,
      generationDocsHash,
      snapshot: input.snapshot,
      priorGeneration: active.generatedCommunityGeneration,
      records,
    };
  }

  adoptStagedGeneration(
    candidate: GeneratedCommunityProjectionCandidate,
    currentSnapshot: KbCorpusSnapshot,
  ): GeneratedCommunityAdoptResult {
    const current = this.readActiveGeneration();
    if (!sameSnapshot(currentSnapshot, candidate.snapshot)) {
      this.discardStagedGeneration(candidate);
      return {
        status: 'discarded',
        reason: 'stale_snapshot',
        generation: candidate.generation,
        currentSnapshot,
        priorGeneration: candidate.priorGeneration,
        currentGeneration: current.generatedCommunityGeneration,
      };
    }
    if (current.generatedCommunityGeneration !== candidate.priorGeneration) {
      this.discardStagedGeneration(candidate);
      return {
        status: 'discarded',
        reason: 'stale_generated_generation',
        generation: candidate.generation,
        currentSnapshot,
        priorGeneration: candidate.priorGeneration,
        currentGeneration: current.generatedCommunityGeneration,
      };
    }

    const finalDir = join(this.rootDir, GENERATIONS_DIR, candidate.generationId);
    this.files.mkdirSync(join(this.rootDir, GENERATIONS_DIR), { recursive: true });
    this.files.rmSync(finalDir, { recursive: true, force: true });
    this.files.renameSync(candidate.stagingDir, finalDir);
    const pointer: ActivePointer = {
      schemaVersion: STORE_SCHEMA_VERSION,
      generation: candidate.generation,
      generationId: candidate.generationId,
      topologyHash: candidate.topologyHash,
      generationDocsHash: candidate.generationDocsHash,
      snapshot: candidate.snapshot,
    };
    writeFileAtomic(this.host, join(this.rootDir, ACTIVE_POINTER_FILE), `${JSON.stringify(pointer, null, 2)}\n`);
    this.cleanupOldGenerations(candidate.generationId);
    return {
      status: 'adopted',
      generation: candidate.generation,
      generatedCommunityDocsHash: candidate.generationDocsHash,
    };
  }

  discardStagedGeneration(candidate: Pick<GeneratedCommunityProjectionCandidate, 'stagingDir'>): void {
    this.files.rmSync(candidate.stagingDir, { recursive: true, force: true });
  }

  updateGeneratedSummary(input: {
    readonly slug: string;
    readonly summary: string;
    readonly summaryInputFingerprint: string;
  }): GeneratedCommunityProjectionCandidate | null {
    const active = this.readActiveGeneration();
    const source = active.records.find((record) => record.slug === input.slug);
    if (source === undefined || active.snapshot === null) {
      return null;
    }
    const documents: CommunityDocument[] = active.records.map((record) => {
      const summary = record.slug === input.slug ? input.summary : record.summary;
      const summaryInputFingerprint =
        record.slug === input.slug ? input.summaryInputFingerprint : record.summaryInputFingerprint;
      const content = record.slug === input.slug ? this.renderUpdatedSummaryContent(record, input) : record.content;
      return {
        slug: record.slug,
        title: record.title,
        level: record.level,
        members: [...record.members],
        ...(record.parent === undefined ? {} : { parent: record.parent }),
        ...(record.children === undefined ? {} : { children: [...record.children] }),
        ...(summary === undefined ? {} : { summary }),
        ...(summaryInputFingerprint === undefined ? {} : { summaryInputFingerprint }),
        createdAt: record.createdAt,
        updatedAt: record.slug === input.slug ? new Date(this.time.now()).toISOString().slice(0, 10) : record.updatedAt,
        content,
      };
    });
    return this.stageGeneration({
      snapshot: active.snapshot,
      topologyHash: active.topologyHash,
      documents,
    });
  }

  private renderUpdatedSummaryContent(
    record: GeneratedCommunityDocumentRecord,
    input: { readonly summary: string; readonly summaryInputFingerprint: string },
  ): string {
    const frontmatter = readYamlFrontmatterRecord(record.content) ?? {};
    frontmatter.summaryInputFingerprint = input.summaryInputFingerprint;
    frontmatter.updatedAt = new Date(this.time.now()).toISOString().slice(0, 10);
    frontmatter[GENERATED_COMMUNITY_MARKER] = true;
    const header = `---\n${yaml.stringify(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n`;
    const body = extractBody(record.content);
    const withoutSummary = body.replace(/^## Summary\r?\n\r?\n[\s\S]*?(?=\r?\n## Members\r?\n|$)/, '').trimStart();
    return `${header}# ${record.title}\n\n## Summary\n\n${input.summary}\n\n${withoutSummary}\n`;
  }

  private readActivePointerWithRecords(): GenerationPointer | null {
    const pointerPath = join(this.rootDir, ACTIVE_POINTER_FILE);
    let pointer: ActivePointer;
    try {
      const parsed = JSON.parse(this.files.readFileSync(pointerPath, 'utf-8')) as unknown;
      if (!isActivePointer(parsed)) {
        throw new Error('Generated community active pointer is malformed.');
      }
      pointer = parsed;
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return null;
      }
      throw error;
    }

    const manifest = this.readManifest(join(this.rootDir, GENERATIONS_DIR, pointer.generationId, MANIFEST_FILE));
    if (
      manifest === null ||
      manifest.generation !== pointer.generation ||
      manifest.generationId !== pointer.generationId
    ) {
      throw new Error(`Generated community generation ${pointer.generationId} is missing or malformed.`);
    }
    return {
      ...pointer,
      records: manifest.records,
    };
  }

  private readManifest(path: string): StoredManifest | null {
    try {
      const parsed = JSON.parse(this.files.readFileSync(path, 'utf-8')) as unknown;
      return isStoredManifest(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private cleanupOldGenerations(activeGenerationId: string): void {
    const generationsDir = join(this.rootDir, GENERATIONS_DIR);
    let entries: string[];
    try {
      entries = this.files.readdirSync(generationsDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === activeGenerationId) {
        continue;
      }
      this.files.rmSync(join(generationsDir, entry), { recursive: true, force: true });
    }
  }
}
