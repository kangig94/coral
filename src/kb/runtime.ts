import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { load, save, type RawData } from '@orama/orama';
import type BetterSqlite3 from 'better-sqlite3';
import { errorMessage, isNoEntryError, isRecord, isStringArray } from '../shared/utils.js';
import { backendLog } from '../shared/backend-log.js';
import { readPendingRepairRows, type PendingRepairRetryCandidate } from './curate/retry.js';
import {
  type CanonicalFrontmatterRecord,
  computeContentManifestHash,
  computeContentSurfaceHash,
  computeMetadataManifestHash,
  computeMetadataSurfaceHash,
  type ContentManifestEntry,
  type CorpusSnapshot,
  type MetadataManifestInput,
} from './corpus/snapshot.js';
import type {
  KbCachedOramaIndex,
  KbCorpusLane,
  KbCorpusPublishCallbacks,
  KbCorpusPublication,
  KbCorpusSnapshot,
  KbIndexMutationLane,
  KbIndexState,
  KbPersistCorpusStateResult,
  KbRuntime,
  KbTextArtifactsSnapshot,
} from './contracts.js';
import {
  INBOUND_SYNC_ORAMA_DELTA_THRESHOLD,
  createKbMutationLock,
  type KbMutationLockContext,
  type KbMutationLockOptions,
} from './corpus/mutation-lock.js';
import {
  extractBody,
  extractTitle,
  normalizeCommunityChildren,
  normalizeCommunityParent,
  parseFrontmatter,
  parseSourceFrontmatter,
} from './corpus/frontmatter.js';
import { buildNoteIndexEntry, buildSourceIndexEntry, cloneKbIndex, writeFileAtomic } from './corpus/mutation-helpers.js';
import { createOramaDb } from './orama-factory.js';
import type { KbOramaDb, KbOramaTokenizer } from './orama-schema.js';
import { sortedMarkdownEntries } from './corpus/markdown-entries.js';
import {
  communityPathFromName,
  communitiesDir as pathsCommunitiesDir,
  notePathFromName,
  notesDir as pathsNotesDir,
  oramaSnapshotDir,
  principlePathFromName,
  principlesDir as pathsPrinciplesDir,
  sourceImportStageDir as pathsSourceImportStageDir,
  sourcePathFromName,
  sourcesDir as pathsSourcesDir,
  stripMdExt,
} from './paths.js';
import { detectTextArtifactRebuildInfo, rebuildTextArtifactsAndPersistRepairState } from './curate/text-artifacts.js';
import {
  communityEntryId,
  ENTITY_TYPES,
  RELATIONSHIP_TYPES,
  type CommunityEntry,
  type EntityGraph,
  type EntityMeta,
  type EntityRelationship,
  type EntityType,
  isCommunityEntry,
  isNoteEntry,
  isSourceEntry,
  noteEntryId,
  parseKbEntryId,
  sourceEntryId,
  type KbIndex,
  type NoteEntry,
  type RelationshipType,
  type SourceEntry,
} from './entry-types.js';
import {
  assertCommunitySlug,
  assertNonEmptyText,
  assertNoteSlug,
  assertSourceSlug,
  parseNonNegativeInteger,
  parseOptionalTrimmedString,
  parsePositiveInteger,
} from './validation.js';
import { createOramaBaseProjection } from './search/orama-backend.js';
import { createCorpusStateMirror } from './runtime-state.js';
import { loadKbNote, loadKbSource } from './read.js';
import { runEntrySeqUpgradeGuard } from './corpus/entry-seq-guard.js';
import { openStoreDatabase } from '../store/db.js';
import { ensureStoreMigrationsDir } from '../store/migrations.js';
import { createRealRuntime } from '../runtime/real.js';

// TODO(phase-6-runtime-follow-up): split this module into narrower runtime slices once the
// Phase 5 search/layering fixes have landed and stabilized.

const INDEX_STATE_FILE = 'index-state.json';
const INDEX_FILE = 'index.json';
const ORAMA_INDEX_FILE = 'orama-index.json';
export const KB_ENTRYSEQ_MIGRATION_VERSION = 1;
const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);
const RELATIONSHIP_TYPE_SET = new Set<string>(RELATIONSHIP_TYPES);

type PersistedKbIndexState = Omit<KbIndexState, 'mutationSeq' | 'textIndexedSeq'>;
type KbIndexStateSnapshot = Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>;
type SearchVisibleEntry = NoteEntry | SourceEntry | CommunityEntry;

function maxIndexSeq(state: KbIndexStateSnapshot): number {
  return Math.max(state.contentSeq, state.metadataSeq);
}

function withLegacyIndexStateAliases(state: PersistedKbIndexState): KbIndexState {
  const mutationSeq = maxIndexSeq(state);
  return {
    ...state,
    mutationSeq,
    textIndexedSeq: mutationSeq,
  };
}

function stripLegacyIndexStateAliases(state: KbIndexState): PersistedKbIndexState {
  const { mutationSeq: _mutationSeq, textIndexedSeq: _textIndexedSeq, ...persisted } = state;
  return persisted;
}

function withoutTextStaleReason(state: PersistedKbIndexState): PersistedKbIndexState {
  const { textStaleReason: _textStaleReason, ...nextState } = state;
  return nextState;
}

function captureIndexStateSnapshot(state: KbIndexState | PersistedKbIndexState | null): KbIndexStateSnapshot {
  return {
    contentSeq: state?.contentSeq ?? 0,
    metadataSeq: state?.metadataSeq ?? 0,
  };
}

function indexStateMatchesSnapshot(state: KbIndexStateSnapshot, snapshot: KbIndexStateSnapshot): boolean {
  return state.contentSeq === snapshot.contentSeq && state.metadataSeq === snapshot.metadataSeq;
}

function isSearchVisibleEntry(entry: KbIndex['entries'][string] | undefined): entry is SearchVisibleEntry {
  return entry !== undefined && (isNoteEntry(entry) || isSourceEntry(entry) || isCommunityEntry(entry));
}

function entryFingerprint(entry: SearchVisibleEntry): string {
  return JSON.stringify(entry);
}

function diffSearchVisibleEntryIds(previous: KbIndex, next: KbIndex): {
  changedEntryIds: string[];
  deletedEntryIds: string[];
} {
  const changedEntryIds = new Set<string>();
  const deletedEntryIds = new Set<string>();
  const entryIds = new Set([
    ...Object.keys(previous.entries),
    ...Object.keys(next.entries),
  ]);

  for (const entryId of entryIds) {
    const previousEntry = previous.entries[entryId];
    const nextEntry = next.entries[entryId];
    const previousVisible = isSearchVisibleEntry(previousEntry) ? previousEntry : undefined;
    const nextVisible = isSearchVisibleEntry(nextEntry) ? nextEntry : undefined;

    if (previousVisible === undefined && nextVisible === undefined) {
      continue;
    }
    if (nextVisible === undefined) {
      deletedEntryIds.add(entryId);
      continue;
    }
    if (previousVisible === undefined || entryFingerprint(previousVisible) !== entryFingerprint(nextVisible)) {
      changedEntryIds.add(entryId);
    }
  }

  return {
    changedEntryIds: [...changedEntryIds].sort(),
    deletedEntryIds: [...deletedEntryIds].sort(),
  };
}

function applyMutationLane(state: PersistedKbIndexState, lane: KbIndexMutationLane | null): PersistedKbIndexState {
  if (lane === null) {
    return state;
  }

  const nextSeq = maxIndexSeq(state) + 1;
  return {
    ...state,
    contentSeq: lane === 'content' || lane === 'both' ? nextSeq : state.contentSeq,
    metadataSeq: lane === 'metadata' || lane === 'both' ? nextSeq : state.metadataSeq,
  };
}

function isLegacyRawIndexState(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !('contentSeq' in value) && 'mutationSeq' in value;
}

function defaultIndexState(): KbIndexState {
  return {
    contentSeq: 0,
    metadataSeq: 0,
    mutationSeq: 0,
    textIndexedSeq: 0,
  };
}

function emptyIndex(): KbIndex {
  return {
    entries: {},
    principles: {},
    entityMeta: {},
    relationships: [],
  };
}

function deriveStableCorpusSnapshotId(snapshot: Omit<CorpusSnapshot, 'snapshotId'>): string {
  const digest = createHash('sha256')
    .update(
      [
        snapshot.contentSeq.toString(10),
        snapshot.metadataSeq.toString(10),
        snapshot.contentManifestHash,
        snapshot.metadataManifestHash,
      ].join('\t'),
      'utf8',
    )
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function collectContentManifestEntries(
  runtime: Pick<KbRuntime, 'notesDir' | 'sourcesDir'>,
): ContentManifestEntry[] {
  const entries: ContentManifestEntry[] = [];

  for (const filename of sortedMarkdownEntries(runtime.notesDir())) {
    const slug = stripMdExt(filename);
    const raw = readFileSync(join(runtime.notesDir(), filename), 'utf-8');
    entries.push({
      entryId: noteEntryId(slug),
      title: extractTitle(raw),
      body: extractBody(raw),
    });
  }

  for (const filename of sortedMarkdownEntries(runtime.sourcesDir())) {
    const slug = stripMdExt(filename);
    try {
      const raw = readFileSync(join(runtime.sourcesDir(), filename), 'utf-8');
      entries.push({
        entryId: sourceEntryId(slug),
        title: parseSourceFrontmatter(raw).title,
        body: extractBody(raw),
      });
    } catch {
      continue;
    }
  }

  return entries;
}

function collectMetadataManifestInputs(
  runtime: Pick<KbRuntime, 'notesDir' | 'sourcesDir' | 'communitiesDir' | 'principlesDir' | 'entityGraphPath'>,
): MetadataManifestInput[] {
  const inputs: MetadataManifestInput[] = [];

  for (const filename of sortedMarkdownEntries(runtime.notesDir())) {
    const slug = stripMdExt(filename);
    try {
      const raw = readFileSync(join(runtime.notesDir(), filename), 'utf-8');
      inputs.push({
        manifestId: `note-meta:${slug}`,
        frontmatter: parseFrontmatter(raw) as unknown as CanonicalFrontmatterRecord,
      });
    } catch {
      continue;
    }
  }

  for (const filename of sortedMarkdownEntries(runtime.sourcesDir())) {
    const slug = stripMdExt(filename);
    try {
      const raw = readFileSync(join(runtime.sourcesDir(), filename), 'utf-8');
      const { title: _title, ...metadata } = parseSourceFrontmatter(raw);
      inputs.push({
        manifestId: `source-meta:${slug}`,
        frontmatter: metadata as unknown as CanonicalFrontmatterRecord,
      });
    } catch {
      continue;
    }
  }

  for (const filename of sortedMarkdownEntries(runtime.communitiesDir())) {
    const slug = stripMdExt(filename);
    inputs.push({
      manifestId: `community:${slug}`,
      rawBytes: readFileSync(join(runtime.communitiesDir(), filename), 'utf-8'),
    });
  }

  for (const filename of sortedMarkdownEntries(runtime.principlesDir())) {
    const slug = stripMdExt(filename);
    inputs.push({
      manifestId: `principle:${slug}`,
      rawBytes: readFileSync(join(runtime.principlesDir(), filename), 'utf-8'),
    });
  }

  try {
    inputs.push({
      manifestId: 'entity-graph:.entity-graph.json',
      rawBytes: readFileSync(runtime.entityGraphPath(), 'utf-8'),
    });
  } catch (error: unknown) {
    if (!isNoEntryError(error)) {
      throw error;
    }
  }

  return inputs;
}

function buildCorpusSnapshot(
  runtime: Pick<KbRuntime, 'notesDir' | 'sourcesDir' | 'communitiesDir' | 'principlesDir' | 'entityGraphPath'>,
  state: KbIndexStateSnapshot,
): CorpusSnapshot {
  const snapshotWithoutId = {
    contentSeq: state.contentSeq,
    metadataSeq: state.metadataSeq,
    contentManifestHash: computeContentManifestHash(collectContentManifestEntries(runtime)),
    metadataManifestHash: computeMetadataManifestHash(collectMetadataManifestInputs(runtime)),
  };

  return {
    ...snapshotWithoutId,
    snapshotId: deriveStableCorpusSnapshotId(snapshotWithoutId),
  };
}


function parseStringArray(value: unknown): string[] {
  if (!isStringArray(value)) {
    throw new Error('Invalid KB index');
  }

  return [...value];
}

function parseNonEmptyStringArray(
  value: unknown,
  field: string,
  errorMessageText = 'Invalid KB entity graph',
): string[] {
  if (!isStringArray(value)) {
    throw new Error(errorMessageText);
  }

  return value.map((entry, index) => assertNonEmptyText(entry, `${field}[${index}]`));
}

function parseEntityType(value: unknown, errorMessageText = 'Invalid KB entity graph'): EntityType {
  if (typeof value !== 'string' || !ENTITY_TYPE_SET.has(value)) {
    throw new Error(errorMessageText);
  }

  return value as EntityType;
}

function parseRelationshipType(value: unknown, errorMessageText = 'Invalid KB entity graph'): RelationshipType {
  if (typeof value !== 'string' || !RELATIONSHIP_TYPE_SET.has(value)) {
    throw new Error(errorMessageText);
  }

  return value as RelationshipType;
}

function parseEntityMetaMap(value: unknown, errorMessageText = 'Invalid KB entity graph'): Record<string, EntityMeta> {
  if (!isRecord(value)) {
    throw new Error(errorMessageText);
  }

  return Object.fromEntries(
    Object.entries(value).map(([entityName, rawMeta]) => {
      if (!isRecord(rawMeta)) {
        throw new Error(errorMessageText);
      }

      const aliases = rawMeta.aliases;
      return [
        assertNonEmptyText(entityName, 'entityMeta key'),
        {
          type: parseEntityType(rawMeta.type, errorMessageText),
          description: assertNonEmptyText(rawMeta.description, 'entity description'),
          ...(aliases === undefined
            ? {}
            : { aliases: parseNonEmptyStringArray(aliases, `entityMeta.${entityName}.aliases`, errorMessageText) }),
        },
      ];
    }),
  );
}

function parseEntityRelationships(value: unknown, errorMessageText = 'Invalid KB entity graph'): EntityRelationship[] {
  if (!Array.isArray(value)) {
    throw new Error(errorMessageText);
  }

  return value.map((rawRelationship, index) => {
    if (!isRecord(rawRelationship)) {
      throw new Error(errorMessageText);
    }

    return {
      source: assertNonEmptyText(rawRelationship.source, `relationships[${index}].source`),
      target: assertNonEmptyText(rawRelationship.target, `relationships[${index}].target`),
      type: parseRelationshipType(rawRelationship.type, errorMessageText),
      description: assertNonEmptyText(rawRelationship.description, `relationships[${index}].description`),
      evidence: parseNonEmptyStringArray(
        rawRelationship.evidence,
        `relationships[${index}].evidence`,
        errorMessageText,
      ),
    };
  });
}

function parseEntityGraph(value: unknown): EntityGraph {
  if (!isRecord(value) || !('entityMeta' in value) || !('relationships' in value)) {
    throw new Error('Invalid KB entity graph');
  }

  return {
    entityMeta: parseEntityMetaMap(value.entityMeta),
    relationships: parseEntityRelationships(value.relationships),
  };
}

function parseEntryIdArray(value: unknown): string[] {
  const values = parseStringArray(value);
  return values.map((entryId) => {
    const normalized = parseKbEntryId(entryId);
    if (normalized === null) {
      throw new Error('Invalid KB index');
    }
    return normalized;
  });
}

function parseNoteIndexEntry(entryId: string, value: Record<string, unknown>): NoteEntry {
  if ('mutationSeqAtPromote' in value) {
    throw new Error('Invalid KB index');
  }

  const slug = assertNoteSlug(value.slug, 'KB index entry slug');
  if (entryId !== noteEntryId(slug)) {
    throw new Error('Invalid KB index');
  }

  return {
    kind: 'note',
    slug,
    title: assertNonEmptyText(value.title, 'KB index entry title'),
    tags: parseStringArray(value.tags),
    principles: parseStringArray(value.principles),
    source: parseStringArray(value.source),
    createdAt: assertNonEmptyText(value.createdAt, 'KB index entry createdAt'),
    updatedAt: assertNonEmptyText(value.updatedAt, 'KB index entry updatedAt'),
    ...(value.entrySeq !== undefined ? { entrySeq: parsePositiveInteger(value.entrySeq, 'entrySeq') } : {}),
    related: value.related === undefined ? [] : parseEntryIdArray(value.related),
  };
}

function parseSourceIndexEntry(entryId: string, value: Record<string, unknown>): SourceEntry {
  if ('mutationSeqAtPromote' in value) {
    throw new Error('Invalid KB index');
  }

  const slug = assertSourceSlug(value.slug, 'KB index entry slug');
  if (entryId !== sourceEntryId(slug)) {
    throw new Error('Invalid KB index');
  }
  const url = value.url;
  if (url !== undefined && typeof url !== 'string') {
    throw new Error('Invalid KB index');
  }

  return {
    kind: 'source',
    slug,
    title: assertNonEmptyText(value.title, 'KB index entry title'),
    type: assertNonEmptyText(value.type, 'KB index entry type'),
    tags: parseStringArray(value.tags),
    ...(url === undefined ? {} : { url: assertNonEmptyText(url, 'KB index entry url') }),
    importedAt: assertNonEmptyText(value.importedAt, 'KB index entry importedAt'),
    ...(value.entrySeq !== undefined ? { entrySeq: parsePositiveInteger(value.entrySeq, 'entrySeq') } : {}),
    related: value.related === undefined ? [] : parseEntryIdArray(value.related),
  };
}

function parseCommunityIndexEntry(entryId: string, value: Record<string, unknown>): CommunityEntry {
  const slug = assertCommunitySlug(value.slug, 'KB index entry slug');
  if (entryId !== communityEntryId(slug)) {
    throw new Error('Invalid KB index');
  }

  const parent = normalizeCommunityParent(value.parent);
  const children = normalizeCommunityChildren(value.children);
  const summary = parseOptionalTrimmedString(value.summary, 'summary');

  return {
    kind: 'community',
    slug,
    title: assertNonEmptyText(value.title, 'KB index entry title'),
    level: parseNonNegativeInteger(value.level ?? 0, 'level'),
    members: parseStringArray(value.members),
    ...(parent === undefined ? {} : { parent }),
    ...(children === undefined ? {} : { children }),
    ...(summary === undefined ? {} : { summary }),
    createdAt: assertNonEmptyText(value.createdAt, 'KB index entry createdAt'),
    updatedAt: assertNonEmptyText(value.updatedAt, 'KB index entry updatedAt'),
  };
}

function parseIndex(value: unknown): KbIndex {
  if (!isRecord(value) || !isRecord(value.entries) || !isRecord(value.principles)) {
    throw new Error('Invalid KB index');
  }

  const entries: KbIndex['entries'] = {};
  for (const [entryId, rawEntry] of Object.entries(value.entries)) {
    if (!isRecord(rawEntry)) {
      throw new Error('Invalid KB index');
    }

    if (rawEntry.kind === 'note') {
      entries[entryId] = parseNoteIndexEntry(entryId, rawEntry);
      continue;
    }

    if (rawEntry.kind === 'source') {
      entries[entryId] = parseSourceIndexEntry(entryId, rawEntry);
      continue;
    }

    if (rawEntry.kind === 'community') {
      entries[entryId] = parseCommunityIndexEntry(entryId, rawEntry);
      continue;
    }

    throw new Error('Invalid KB index');
  }

  const principles: KbIndex['principles'] = {};
  for (const [name, statement] of Object.entries(value.principles)) {
    if (typeof statement !== 'string') {
      throw new Error('Invalid KB index');
    }
    principles[name] = statement;
  }

  const entityMeta =
    value.entityMeta === undefined ? undefined : parseEntityMetaMap(value.entityMeta, 'Invalid KB index');
  const relationships =
    value.relationships === undefined ? undefined : parseEntityRelationships(value.relationships, 'Invalid KB index');

  return {
    entries,
    principles,
    ...(entityMeta === undefined ? {} : { entityMeta }),
    ...(relationships === undefined ? {} : { relationships }),
  };
}

function parseIndexState(value: unknown): KbIndexState {
  if (!isRecord(value)) {
    throw new Error('Invalid KB index state');
  }

  const hasSemanticLanes = value.contentSeq !== undefined || value.metadataSeq !== undefined;
  const contentSeq = hasSemanticLanes ? value.contentSeq : value.mutationSeq;
  const metadataSeq = hasSemanticLanes ? value.metadataSeq : value.mutationSeq;
  const legacyTextIndexedSeq = value.textIndexedSeq ?? value.indexedSeq;
  const textStaleReason = value.textStaleReason ?? value.staleReason;
  if (typeof contentSeq !== 'number' || !Number.isInteger(contentSeq) || contentSeq < 0) {
    throw new Error('Invalid KB index state');
  }
  if (typeof metadataSeq !== 'number' || !Number.isInteger(metadataSeq) || metadataSeq < 0) {
    throw new Error('Invalid KB index state');
  }
  if (textStaleReason !== undefined && typeof textStaleReason !== 'string') {
    throw new Error('Invalid KB index state');
  }

  const migratedLegacyState =
    !hasSemanticLanes && legacyTextIndexedSeq !== undefined && legacyTextIndexedSeq !== contentSeq
      ? 'KB text snapshot requires lane-state migration rebuild.'
      : undefined;

  return withLegacyIndexStateAliases({
    contentSeq,
    metadataSeq,
    ...(typeof textStaleReason === 'string'
      ? { textStaleReason }
      : migratedLegacyState === undefined
        ? {}
        : { textStaleReason: migratedLegacyState }),
  });
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isFreshTextSnapshot(state: KbIndexState | null): state is KbIndexState {
  return state !== null && state.textStaleReason === undefined;
}

type PublishQueueEntry = {
  publication: KbCorpusPublication;
  persisted: boolean;
};

type MutationLockContext = KbMutationLockContext<KbIndex, KbCorpusPublication, KbIndexMutationLane>;

type CorpusFilesystemSnapshot = {
  notes: Map<string, { contentHash: string; metadataHash: string }>;
  sources: Map<string, { contentHash: string; metadataHash: string }>;
  principles: Map<string, string>;
  communities: Map<string, string>;
  entityGraphHash: string | null;
};

type InboundSyncMutationDiff = {
  lane: KbIndexMutationLane | null;
  changedEntryIds: string[];
  requiresFullInstall: boolean;
};

export interface CreateKbRuntimeOptions {
  markdownRoot: string;
  runtimeDir: string;
  db?: BetterSqlite3.Database;
  corpusPublishCallbacks?: KbCorpusPublishCallbacks;
  readOnlyOrama?: boolean;
}

const NOOP_CORPUS_PUBLISH_CALLBACKS: KbCorpusPublishCallbacks = {
  persistCorpusState(snapshot) {
    return {
      snapshot,
      changedLanes: [],
    };
  },
  notifyCorpusMutation() {},
};

function createFallbackKbDb(runtimeDir: string): BetterSqlite3.Database {
  const runtime = createRealRuntime();
  return openStoreDatabase({
    path: join(runtimeDir, 'store.db'),
    storage: runtime.storage,
    migrationsDir: ensureStoreMigrationsDir(runtime.storage),
  });
}

function mergeMutationLane(
  current: KbIndexMutationLane | null,
  next: KbIndexMutationLane | null,
): KbIndexMutationLane | null {
  if (next === null || current === 'both') {
    return current;
  }
  if (current === null || current === next) {
    return next;
  }
  return 'both';
}

function mergeCorpusLanes(current: readonly KbCorpusLane[], next: readonly KbCorpusLane[]): KbCorpusLane[] {
  const merged = new Set<KbCorpusLane>(current);
  for (const lane of next) {
    merged.add(lane);
  }

  return [...merged].sort();
}

function sameCorpusSnapshot(left: CorpusSnapshot, right: CorpusSnapshot): boolean {
  return (
    left.snapshotId === right.snapshotId &&
    left.contentSeq === right.contentSeq &&
    left.metadataSeq === right.metadataSeq &&
    left.contentManifestHash === right.contentManifestHash &&
    left.metadataManifestHash === right.metadataManifestHash
  );
}

function mutationLanesFromDiff(before: KbIndexStateSnapshot, after: KbIndexStateSnapshot): KbCorpusLane[] {
  const changedLanes: KbCorpusLane[] = [];
  if (after.contentSeq > before.contentSeq) {
    changedLanes.push('content');
  }
  if (after.metadataSeq > before.metadataSeq) {
    changedLanes.push('metadata');
  }

  return changedLanes;
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

function mergePublication(
  current: KbCorpusPublication | null,
  next: KbCorpusPublication,
): KbCorpusPublication {
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

function captureNoteFileSnapshot(dirPath: string): Map<string, { contentHash: string; metadataHash: string }> {
  const snapshot = new Map<string, { contentHash: string; metadataHash: string }>();

  for (const entry of sortedMarkdownEntries(dirPath)) {
    const slug = stripMdExt(entry);
    const raw = readFileSync(join(dirPath, entry), 'utf-8');
    try {
      snapshot.set(slug, {
        contentHash: computeContentSurfaceHash({
          title: extractTitle(raw),
          body: extractBody(raw),
        }),
        metadataHash: computeMetadataSurfaceHash({
          frontmatter: parseFrontmatter(raw) as unknown as CanonicalFrontmatterRecord,
        }),
      });
    } catch {
      const rawHash = createHash('sha256').update(raw).digest('hex');
      snapshot.set(slug, {
        contentHash: rawHash,
        metadataHash: rawHash,
      });
    }
  }

  return snapshot;
}

function captureSourceFileSnapshot(dirPath: string): Map<string, { contentHash: string; metadataHash: string }> {
  const snapshot = new Map<string, { contentHash: string; metadataHash: string }>();

  for (const entry of sortedMarkdownEntries(dirPath)) {
    const slug = stripMdExt(entry);
    const raw = readFileSync(join(dirPath, entry), 'utf-8');
    try {
      const { title, ...metadata } = parseSourceFrontmatter(raw);
      snapshot.set(slug, {
        contentHash: computeContentSurfaceHash({
          title,
          body: extractBody(raw),
        }),
        metadataHash: computeMetadataSurfaceHash({
          frontmatter: metadata as unknown as CanonicalFrontmatterRecord,
        }),
      });
    } catch {
      const rawHash = createHash('sha256').update(raw).digest('hex');
      snapshot.set(slug, {
        contentHash: rawHash,
        metadataHash: rawHash,
      });
    }
  }

  return snapshot;
}

function captureMarkdownFileHashes(dirPath: string): Map<string, string> {
  const snapshot = new Map<string, string>();

  for (const entry of sortedMarkdownEntries(dirPath)) {
    snapshot.set(stripMdExt(entry), createHash('sha256').update(readFileSync(join(dirPath, entry), 'utf-8')).digest('hex'));
  }

  return snapshot;
}

function captureEntityGraphHash(filePath: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(filePath, 'utf-8')).digest('hex');
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return null;
    }
    throw error;
  }
}

function captureCorpusFilesystemSnapshot(
  runtime: Pick<KbRuntime, 'notesDir' | 'sourcesDir' | 'principlesDir' | 'communitiesDir' | 'entityGraphPath'>,
): CorpusFilesystemSnapshot {
  return {
    notes: captureNoteFileSnapshot(runtime.notesDir()),
    sources: captureSourceFileSnapshot(runtime.sourcesDir()),
    principles: captureMarkdownFileHashes(runtime.principlesDir()),
    communities: captureMarkdownFileHashes(runtime.communitiesDir()),
    entityGraphHash: captureEntityGraphHash(runtime.entityGraphPath()),
  };
}

function inboundSnapshotMapsEqual(left: Map<string, string>, right: Map<string, string>): boolean {
  return (
    left.size === right.size &&
    [...left.entries()].every(([key, value]) => right.get(key) === value)
  );
}

function detectInboundSyncMutation(
  before: CorpusFilesystemSnapshot,
  after: CorpusFilesystemSnapshot,
): InboundSyncMutationDiff {
  let lane: KbIndexMutationLane | null = null;
  const changedEntryIds = new Set<string>();

  const noteSlugs = new Set([...before.notes.keys(), ...after.notes.keys()]);
  for (const slug of noteSlugs) {
    const beforeEntry = before.notes.get(slug);
    const afterEntry = after.notes.get(slug);
    if (beforeEntry === undefined && afterEntry === undefined) {
      continue;
    }

    changedEntryIds.add(noteEntryId(slug));
    if (beforeEntry === undefined || afterEntry === undefined) {
      lane = mergeMutationLane(lane, 'both');
      continue;
    }
    if (beforeEntry.contentHash !== afterEntry.contentHash) {
      lane = mergeMutationLane(lane, 'content');
    }
    if (beforeEntry.metadataHash !== afterEntry.metadataHash) {
      lane = mergeMutationLane(lane, 'metadata');
    }
  }

  const sourceSlugs = new Set([...before.sources.keys(), ...after.sources.keys()]);
  for (const slug of sourceSlugs) {
    const beforeEntry = before.sources.get(slug);
    const afterEntry = after.sources.get(slug);
    if (beforeEntry === undefined && afterEntry === undefined) {
      continue;
    }

    changedEntryIds.add(sourceEntryId(slug));
    if (beforeEntry === undefined || afterEntry === undefined) {
      lane = mergeMutationLane(lane, 'both');
      continue;
    }
    if (beforeEntry.contentHash !== afterEntry.contentHash) {
      lane = mergeMutationLane(lane, 'content');
    }
    if (beforeEntry.metadataHash !== afterEntry.metadataHash) {
      lane = mergeMutationLane(lane, 'metadata');
    }
  }

  const principlesChanged = !inboundSnapshotMapsEqual(before.principles, after.principles);
  const communitiesChanged = !inboundSnapshotMapsEqual(before.communities, after.communities);
  const entityGraphChanged = before.entityGraphHash !== after.entityGraphHash;

  if (principlesChanged || communitiesChanged || entityGraphChanged) {
    lane = mergeMutationLane(lane, 'metadata');
  }

  return {
    lane,
    changedEntryIds: [...changedEntryIds].sort(),
    requiresFullInstall: principlesChanged || communitiesChanged || entityGraphChanged,
  };
}

class KbRuntimeImpl implements KbRuntime {
  readonly markdownRoot: string;
  readonly runtimeDir: string;
  readonly db: BetterSqlite3.Database;
  private readonly readOnlyOrama: boolean;

  private indexCache: { index: KbIndex | null } | null = null;
  private cachedOramaIndex: KbCachedOramaIndex | null = null;
  private mutationLock: Promise<void> = Promise.resolve();
  private baseProjection = createOramaBaseProjection(this);
  private readonly corpusStateMirror: ReturnType<typeof createCorpusStateMirror>;
  private upgradeGuardDone = false;
  private corpusPublishCallbacks: KbCorpusPublishCallbacks = NOOP_CORPUS_PUBLISH_CALLBACKS;
  private activeMutationContext: MutationLockContext | null = null;
  private readonly publishQueue: PublishQueueEntry[] = [];
  private publishDrain: Promise<void> | null = null;
  private publishDrainRequested = false;
  private consecutivePublishFailures = 0;
  private readonly mutationLockController = createKbMutationLock<KbIndex, KbCorpusPublication, KbIndexMutationLane>({
    cloneStartIndex: () => cloneKbIndex(this.readIndex()),
    getCurrentLock: () => this.mutationLock,
    setCurrentLock: (lock) => {
      this.mutationLock = lock;
    },
    setActiveContext: (context) => {
      this.activeMutationContext = context;
    },
    finalizePendingMutation: (context) => {
      this.finalizePendingMutation(context);
    },
    installPendingBaseProjectionBeforeRelease: (snapshot, context) =>
      this.installPendingBaseProjectionBeforeRelease(snapshot, context),
    recordIndexSyncSuccess: () => {
      this.recordIndexSyncSuccess();
    },
    enqueuePublication: (publication) => {
      this.publishQueue.push({
        publication,
        persisted: false,
      });
    },
    hasQueuedPublications: () => this.publishQueue.length > 0,
    processPublishQueue: () => this.processPublishQueue(),
  });

  constructor({ markdownRoot, runtimeDir, db, corpusPublishCallbacks, readOnlyOrama }: CreateKbRuntimeOptions) {
    this.markdownRoot = markdownRoot;
    this.runtimeDir = runtimeDir;
    this.db = db ?? createFallbackKbDb(runtimeDir);
    this.readOnlyOrama = readOnlyOrama === true;
    this.corpusStateMirror = createCorpusStateMirror(this.db);

    mkdirSync(this.runtimeDir, { recursive: true });

    if (corpusPublishCallbacks !== undefined) {
      this.register(corpusPublishCallbacks);
    }
  }

  notesDir(): string {
    return pathsNotesDir(this.markdownRoot);
  }

  sourcesDir(): string {
    return pathsSourcesDir(this.markdownRoot);
  }

  communitiesDir(): string {
    return pathsCommunitiesDir(this.markdownRoot);
  }

  principlesDir(): string {
    return pathsPrinciplesDir(this.markdownRoot);
  }

  entityGraphPath(): string {
    return join(this.markdownRoot, '.entity-graph.json');
  }

  notePath(note: string): string {
    return notePathFromName(note, this.markdownRoot);
  }

  sourcePath(source: string): string {
    return sourcePathFromName(source, this.markdownRoot);
  }

  communityPath(community: string): string {
    return communityPathFromName(community, this.markdownRoot);
  }

  principlePath(principle: string): string {
    return principlePathFromName(principle, this.markdownRoot);
  }

  sourceImportStageDir(): string {
    return pathsSourceImportStageDir(this.runtimeDir);
  }

  readEntityGraph(): EntityGraph | null {
    const graphPath = this.entityGraphPath();

    try {
      const raw = readFileSync(graphPath, 'utf-8');
      if (raw.includes('<<<<<<<')) {
        throw new Error('Merge conflict markers detected.');
      }

      return parseEntityGraph(JSON.parse(raw) as unknown);
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return null;
      }

      backendLog.warn(
        `KB entity graph is unavailable; graph and community-derived features are disabled: ${errorMessage(error)}`,
      );
      return null;
    }
  }

  async writeEntityGraph(graph: EntityGraph): Promise<void> {
    await this.withMutationLock(() => {
      this.writeEntityGraphLocked(graph);
    });
  }

  writeEntityGraphLocked(graph: EntityGraph): void {
    const normalized = parseEntityGraph(graph);
    writeJsonAtomic(this.entityGraphPath(), normalized);
    this.setMutationLockProjectionDispatchMode('full');
    this.recordMutationCommitted('metadata', 'KB entity graph changed.');

    const currentIndex = this.readIndex();
    if (currentIndex !== null) {
      const nextIndex = cloneKbIndex(currentIndex);
      nextIndex.entityMeta = normalized.entityMeta;
      nextIndex.relationships = normalized.relationships;
      this.writeIndex(nextIndex);
    }
  }

  readIndex(): KbIndex | null {
    if (this.indexCache !== null) {
      return this.indexCache.index;
    }

    const indexPath = this.indexPath();
    try {
      const raw = readFileSync(indexPath, 'utf-8');
      let parsed: KbIndex;
      try {
        parsed = parseIndex(JSON.parse(raw) as unknown);
      } catch {
        this.indexCache = { index: null };
        this.cachedOramaIndex = null;
        rmSync(indexPath, { force: true });
        return null;
      }
      this.indexCache = { index: parsed };
      return parsed;
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        this.indexCache = { index: null };
        return null;
      }
      throw error;
    }
  }

  persistIndexToDisk(index: KbIndex): KbIndex {
    const normalized = parseIndex(index);
    writeJsonAtomic(this.indexPath(), normalized);
    return normalized;
  }

  writeIndex(index: KbIndex): KbIndex {
    return this.installIndexCache(this.persistIndexToDisk(index));
  }

  readIndexOrEmpty(): KbIndex {
    return this.readIndex() ?? emptyIndex();
  }

  readIndexStateIfPresent(): KbIndexState | null {
    try {
      const raw = readFileSync(this.indexStatePath(), 'utf-8');
      const parsedRaw = JSON.parse(raw) as unknown;
      const parsedState = parseIndexState(parsedRaw);
      if (isLegacyRawIndexState(parsedRaw)) {
        this.writeIndexState(parsedState);
      }
      return parsedState;
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return null;
      }
      // Corrupt index-state.json: delete and return null (same as missing).
      // The next mutation or rebuild will recreate it from defaultIndexState().
      rmSync(this.indexStatePath(), { force: true });
      return null;
    }
  }

  readIndexState(): KbIndexState {
    return this.readIndexStateIfPresent() ?? defaultIndexState();
  }

  writeIndexState(state: KbIndexState): void {
    const previousSnapshot = captureIndexStateSnapshot(this.readIndexStateIfPresent());
    const normalizedState = withLegacyIndexStateAliases(stripLegacyIndexStateAliases(state));
    writeJsonAtomic(this.indexStatePath(), stripLegacyIndexStateAliases(normalizedState));
    this.capturePublicationFromStateChange(previousSnapshot, captureIndexStateSnapshot(normalizedState));
  }

  register(corpusPublishCallbacks: KbCorpusPublishCallbacks): void {
    this.corpusPublishCallbacks = corpusPublishCallbacks;
  }

  runEntrySeqUpgradeGuardIfNeeded(): boolean {
    if (this.upgradeGuardDone) {
      return false;
    }

    const changed = runEntrySeqUpgradeGuard(this);
    this.upgradeGuardDone = true;
    if (changed) {
      this.recordMutationCommitted('both', 'KB text snapshot is stale after entry-seq upgrade.');
    }
    return changed;
  }

  recordMutationCommitted(lane: KbIndexMutationLane = 'both', reason?: string): KbIndexState {
    if (this.activeMutationContext !== null) {
      this.activeMutationContext.pendingMutationLane = mergeMutationLane(this.activeMutationContext.pendingMutationLane, lane);
      if (reason !== undefined) {
        this.activeMutationContext.pendingMutationReason = reason;
      }

      const state = stripLegacyIndexStateAliases(this.readIndexState());
      return withLegacyIndexStateAliases({
        ...applyMutationLane(state, this.activeMutationContext.pendingMutationLane),
        ...(this.activeMutationContext.pendingMutationReason === undefined
          ? state.textStaleReason === undefined
            ? {}
            : { textStaleReason: state.textStaleReason }
          : { textStaleReason: this.activeMutationContext.pendingMutationReason }),
      });
    }

    const state = stripLegacyIndexStateAliases(this.readIndexState());
    const nextState = withLegacyIndexStateAliases({
      ...applyMutationLane(state, lane),
      ...(reason === undefined ? {} : { textStaleReason: reason }),
    });
    this.writeIndexState(nextState);
    this.refreshIndexBaselineIfPresent();
    return nextState;
  }

  recordIndexSyncSuccess(): KbIndexState {
    const state = stripLegacyIndexStateAliases(this.readIndexState());
    const nextState = withLegacyIndexStateAliases({
      contentSeq: state.contentSeq,
      metadataSeq: state.metadataSeq,
    });
    this.writeIndexState(nextState);
    return nextState;
  }

  recordIndexSyncFailure(reason: string): KbIndexState {
    const state = stripLegacyIndexStateAliases(this.readIndexState());
    const nextState = withLegacyIndexStateAliases({
      contentSeq: state.contentSeq,
      metadataSeq: state.metadataSeq,
      textStaleReason: reason,
    });
    this.writeIndexState(nextState);
    return nextState;
  }

  recordReindexSuccess(
    startState: Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>,
    externalMutation: KbIndexMutationLane | null = null,
  ): KbIndexState {
    const state = this.readIndexState();
    if (!indexStateMatchesSnapshot(state, startState)) {
      return state;
    }

    const nextState = withLegacyIndexStateAliases({
      ...applyMutationLane(withoutTextStaleReason(stripLegacyIndexStateAliases(state)), externalMutation),
    });
    this.writeIndexState(nextState);
    return nextState;
  }

  getCorpusStateSnapshot(): KbCorpusSnapshot {
    return this.corpusStateMirror.get();
  }

  invalidateCorpusStateSnapshot(): void {
    this.corpusStateMirror.invalidate();
  }

  async ensureIndex(): Promise<KbIndex> {
    if (this.textArtifactsNeedRebuild()) {
      await this.withMutationLock(async () => {
        this.runEntrySeqUpgradeGuardIfNeeded();
        const state = this.readIndexStateIfPresent();
        if (!this.textArtifactsNeedRebuild(state)) {
          return;
        }

        await rebuildTextArtifactsAndPersistRepairState(this, captureIndexStateSnapshot(state));
      });
    }

    return this.readIndex() ?? emptyIndex();
  }

  async ensureOramaIndex(): Promise<{
    db: KbOramaDb;
    tokenizer: KbOramaTokenizer;
    index: KbIndex;
    warnings?: string[];
  }> {
    const state = this.readIndexStateIfPresent();
    if (!this.textArtifactsNeedRebuild(state) && this.cachedOramaIndex !== null && this.indexCache !== null) {
      return {
        ...this.cachedOramaIndex,
        index: this.indexCache.index ?? emptyIndex(),
      };
    }

    if (this.readOnlyOrama) {
      return this.ensureOramaIndexReadOnly();
    }

    if (this.activeMutationContext !== null) {
      return this.ensureOramaIndexInMutationLock();
    }

    return this.withMutationLock(async () => this.ensureOramaIndexInMutationLock());
  }

  async loadOramaSnapshotIfPresent(): Promise<KbCachedOramaIndex | null> {
    if (this.cachedOramaIndex !== null) {
      return this.cachedOramaIndex;
    }

    try {
      const loaded = await this.loadOramaSnapshot();
      this.installOramaCache(loaded);
      return loaded;
    } catch (error: unknown) {
      if (!isNoEntryError(error)) {
        this.cachedOramaIndex = null;
        rmSync(this.oramaIndexPath(), { force: true });
      }
      return null;
    }
  }

  async ensureTextArtifactsFreshUnderLock(): Promise<KbTextArtifactsSnapshot> {
    let rebuilt: Awaited<ReturnType<typeof rebuildTextArtifactsAndPersistRepairState>> | null = null;
    if (this.textArtifactsNeedRebuild()) {
      rebuilt = await rebuildTextArtifactsAndPersistRepairState(
        this,
        captureIndexStateSnapshot(this.readIndexState()),
      );
    } else if (this.cachedOramaIndex === null) {
      try {
        this.installOramaCache(await this.loadOramaSnapshot());
      } catch {
        rebuilt = await rebuildTextArtifactsAndPersistRepairState(
          this,
          captureIndexStateSnapshot(this.readIndexState()),
        );
      }
    }

    if (rebuilt !== null) {
      return this.snapshotFromRebuildResult(rebuilt);
    }

    const stateAfterArtifacts = this.readIndexStateIfPresent();
    if (this.cachedOramaIndex === null || this.textArtifactsNeedRebuild(stateAfterArtifacts)) {
      throw new Error('KB text search is unavailable: a fresh text snapshot could not be installed.');
    }

    return this.captureTextArtifactsSnapshot();
  }

  async withMutationLock<T>(fn: () => Promise<T> | T, options: KbMutationLockOptions = {}): Promise<T> {
    return this.mutationLockController.withMutationLock(fn, options);
  }

  async retryPendingCorpusPublication(): Promise<void> {
    this.publishCurrentSnapshot();
    if (this.publishQueue.length === 0) {
      return;
    }

    await this.processPublishQueue();
  }

  async runInboundSync<T>(fn: () => Promise<T> | T): Promise<T> {
    let mutationDiff: InboundSyncMutationDiff | null = null;

    return this.withMutationLock(async () => {
      const before = captureCorpusFilesystemSnapshot(this);
      const result = await fn();
      const after = captureCorpusFilesystemSnapshot(this);
      mutationDiff = detectInboundSyncMutation(before, after);

      if (mutationDiff.lane !== null) {
        if (!mutationDiff.requiresFullInstall && mutationDiff.changedEntryIds.length > 0) {
          this.writeIndex(this.buildInboundSyncIndexDelta(mutationDiff.changedEntryIds));
        } else if (mutationDiff.requiresFullInstall) {
          this.invalidateKbCache();
        }
        this.recordMutationCommitted(mutationDiff.lane, 'KB text snapshot is stale after inbound git sync.');
      }
      return result;
    }, {
      preReleaseInstallProjection: async (snapshot) => {
        if (mutationDiff === null || mutationDiff.lane === null) {
          return false;
        }

        if (mutationDiff.requiresFullInstall) {
          const preparedProjection = await this.baseProjection.prepareFullSnapshotForCurrentCorpus();
          await this.baseProjection.installFullSnapshotInWriteLock(snapshot, preparedProjection);
          return true;
        }

        const shouldInstallDelta =
          mutationDiff.changedEntryIds.length <= INBOUND_SYNC_ORAMA_DELTA_THRESHOLD;
        if (!shouldInstallDelta) {
          const preparedProjection = await this.baseProjection.prepareFullSnapshotForCurrentCorpus();
          await this.baseProjection.installFullSnapshotInWriteLock(snapshot, preparedProjection);
          return true;
        }

        const preparedDelta = await this.baseProjection.prepareDeltaForCurrentCorpusEntries(
          this.readIndexOrEmpty(),
          mutationDiff.changedEntryIds,
          [],
        );
        await this.baseProjection.applyDeltaInWriteLock(snapshot, preparedDelta);
        return true;
      },
    });
  }

  setMutationLockProjectionDispatchMode(mode: 'delta' | 'full'): void {
    if (this.activeMutationContext === null) {
      throw new Error('KB mutation-lock projection mode can only change while the mutation lock is held.');
    }
    if (mode === 'full') {
      this.activeMutationContext.projectionDispatchMode = 'full';
    }
  }

  captureCurrentCorpusSnapshot(): KbCorpusPublication['snapshot'] {
    return buildCorpusSnapshot(this, captureIndexStateSnapshot(this.readIndexState()));
  }

  private buildInboundSyncIndexDelta(changedEntryIds: readonly string[]): KbIndex {
    const nextIndex = cloneKbIndex(this.activeMutationContext?.startIndex ?? this.readIndex());

    for (const entryId of changedEntryIds) {
      if (entryId.startsWith('note:')) {
        const slug = entryId.slice('note:'.length);
        const notePath = this.notePath(slug);

        try {
          const { frontmatter, title } = loadKbNote(notePath);
          nextIndex.entries[entryId] = buildNoteIndexEntry({
            slug,
            title,
            ...frontmatter,
          });
        } catch (error: unknown) {
          if (!isNoEntryError(error)) {
            throw error;
          }
          delete nextIndex.entries[entryId];
        }
        continue;
      }

      if (entryId.startsWith('source:')) {
        const slug = entryId.slice('source:'.length);
        const sourcePath = this.sourcePath(slug);

        try {
          const { frontmatter } = loadKbSource(sourcePath);
          nextIndex.entries[entryId] = buildSourceIndexEntry({
            slug,
            ...frontmatter,
          });
        } catch (error: unknown) {
          if (!isNoEntryError(error)) {
            throw error;
          }
          delete nextIndex.entries[entryId];
        }
      }
    }

    return nextIndex;
  }

  private async installPendingBaseProjectionBeforeRelease(
    snapshot: CorpusSnapshot,
    lockContext: MutationLockContext,
  ): Promise<boolean> {
    const currentIndex = this.readIndexOrEmpty();
    const delta = diffSearchVisibleEntryIds(lockContext.startIndex, currentIndex);

    if (lockContext.projectionDispatchMode === 'full') {
      const preparedProjection = await this.baseProjection.prepareFullSnapshotForCurrentCorpus(currentIndex);
      await this.baseProjection.installFullSnapshotInWriteLock(snapshot, preparedProjection);
      return true;
    }

    if (delta.changedEntryIds.length === 0 && delta.deletedEntryIds.length === 0) {
      return false;
    }

    const preparedDelta = await this.baseProjection.prepareDeltaForCurrentCorpusEntries(
      currentIndex,
      delta.changedEntryIds,
      delta.deletedEntryIds,
    );
    await this.baseProjection.applyDeltaInWriteLock(snapshot, preparedDelta);
    return true;
  }

  invalidateKbCache(): void {
    this.indexCache = null;
    this.cachedOramaIndex = null;
  }

  invalidateTextSnapshot(reason: string): KbIndexState {
    const nextState = this.recordIndexSyncFailure(reason);
    this.cachedOramaIndex = null;
    rmSync(this.oramaIndexPath(), { force: true });
    return nextState;
  }

  installRebuiltArtifacts(index: KbIndex, orama: KbCachedOramaIndex): KbIndex {
    const normalized = this.installIndexCache(index);
    this.installOramaCache(orama);
    return normalized;
  }

  persistOramaSnapshot(db: KbOramaDb): void {
    const snapshot = save(db) as unknown as RawData;
    writeJsonAtomic(this.oramaIndexPath(), snapshot);
  }

  private publishCurrentSnapshot(): void {
    const stateSnapshot = captureIndexStateSnapshot(this.readIndexStateIfPresent());
    if (stateSnapshot.contentSeq === 0 && stateSnapshot.metadataSeq === 0) {
      return;
    }

    this.publishQueue.push({
      publication: {
        snapshot: buildCorpusSnapshot(this, stateSnapshot),
        changedLanes: ['content', 'metadata'],
      },
      persisted: false,
    });
  }

  private refreshIndexBaselineIfPresent(): void {
    const currentIndex = this.readIndex();
    if (currentIndex === null) {
      return;
    }

    this.persistIndexToDisk(currentIndex);
  }

  private async processPublishQueue(): Promise<void> {
    if (this.publishDrain !== null) {
      this.publishDrainRequested = true;
      return this.publishDrain;
    }

    this.publishDrainRequested = false;
    const drain = Promise.resolve().then(async () => {
      try {
        while (this.publishQueue.length > 0) {
          const current = this.publishQueue[0];
          if (current === undefined) {
            return;
          }

          if (!current.persisted) {
            const mirrorBeforePersist = this.getCorpusStateSnapshot();
            try {
              const persisted = await this.corpusPublishCallbacks.persistCorpusState(current.publication.snapshot);
              current.publication = this.normalizePersistResult(current.publication, persisted);
              if (!sameCorpusSnapshot(mirrorBeforePersist, current.publication.snapshot)) {
                this.invalidateCorpusStateSnapshot();
              }
              current.persisted = true;
            } catch (error: unknown) {
              this.consecutivePublishFailures += 1;
              this.corpusPublishCallbacks.onPublishFailure?.({
                stage: 'persist',
                snapshot: current.publication.snapshot,
                changedLanes: current.publication.changedLanes,
                consecutiveFailures: this.consecutivePublishFailures,
                error,
              });
              return;
            }
          }

          if (current.publication.changedLanes.length === 0) {
            this.publishQueue.shift();
            this.consecutivePublishFailures = 0;
            this.corpusPublishCallbacks.onPublishSuccess?.();
            continue;
          }

          try {
            await this.corpusPublishCallbacks.notifyCorpusMutation(current.publication);
          } catch (error: unknown) {
            this.consecutivePublishFailures += 1;
            this.corpusPublishCallbacks.onPublishFailure?.({
              stage: 'notify',
              snapshot: current.publication.snapshot,
              changedLanes: current.publication.changedLanes,
              consecutiveFailures: this.consecutivePublishFailures,
              error,
            });
            return;
          }

          this.publishQueue.shift();
          this.consecutivePublishFailures = 0;
          this.corpusPublishCallbacks.onPublishSuccess?.();
        }
      } finally {
        if (this.publishDrain === drain) {
          this.publishDrain = null;
        }
        // A publish can enqueue another mutation while we are notifying consumers. Restart once after the
        // current drain unwinds so the queue keeps forward progress without recursive in-drain reentry.
        const shouldRestart = this.publishQueue.length > 0 && this.publishDrainRequested;
        this.publishDrainRequested = false;
        if (shouldRestart) {
          void this.processPublishQueue();
        }
      }
    });
    this.publishDrain = drain;

    return drain;
  }

  private finalizePendingMutation(lockContext: MutationLockContext): void {
    if (lockContext.pendingMutationLane === null) {
      return;
    }

    const state = stripLegacyIndexStateAliases(this.readIndexState());
    const nextState = withLegacyIndexStateAliases({
      ...applyMutationLane(state, lockContext.pendingMutationLane),
      ...(lockContext.pendingMutationReason === undefined
        ? state.textStaleReason === undefined
          ? {}
          : { textStaleReason: state.textStaleReason }
        : { textStaleReason: lockContext.pendingMutationReason }),
    });
    this.writeIndexState(nextState);
    this.refreshIndexBaselineIfPresent();
  }

  private capturePublicationFromStateChange(previous: KbIndexStateSnapshot, next: KbIndexStateSnapshot): void {
    if (this.activeMutationContext === null) {
      return;
    }

    const changedLanes = mutationLanesFromDiff(previous, next);
    if (changedLanes.length === 0) {
      return;
    }

    this.activeMutationContext.publication = mergePublication(this.activeMutationContext.publication, {
      snapshot: buildCorpusSnapshot(this, next),
      changedLanes,
    });
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

  private indexPath(): string {
    return join(this.runtimeDir, INDEX_FILE);
  }

  private indexStatePath(): string {
    return join(this.runtimeDir, INDEX_STATE_FILE);
  }

  private oramaIndexPath(): string {
    return join(oramaSnapshotDir(this.runtimeDir), ORAMA_INDEX_FILE);
  }

  private async ensureOramaIndexInMutationLock(): Promise<{
    db: KbOramaDb;
    tokenizer: KbOramaTokenizer;
    index: KbIndex;
    warnings?: string[];
  }> {
    const state = this.readIndexStateIfPresent();
    const startState = captureIndexStateSnapshot(state);

    if (this.textArtifactsNeedRebuild(state)) {
      try {
        await rebuildTextArtifactsAndPersistRepairState(this, startState);
      } catch (error: unknown) {
        throw new Error(`KB text search is unavailable: ${errorMessage(error)}`, { cause: error });
      }
    } else if (this.cachedOramaIndex === null) {
      try {
        this.installOramaCache(await this.loadOramaSnapshot());
      } catch {
        await this.installCurrentOramaProjectionInWriteLock(startState);
      }
    }

    const stateAfterArtifacts = this.readIndexStateIfPresent();
    if (this.cachedOramaIndex === null || this.textArtifactsNeedRebuild(stateAfterArtifacts)) {
      throw new Error('KB text search is unavailable: a fresh text snapshot could not be installed.');
    }

    return {
      ...this.cachedOramaIndex,
      index: this.readIndex() ?? emptyIndex(),
    };
  }

  private async ensureOramaIndexReadOnly(): Promise<{
    db: KbOramaDb;
    tokenizer: KbOramaTokenizer;
    index: KbIndex;
    warnings?: string[];
  }> {
    if (this.cachedOramaIndex !== null) {
      return {
        ...this.cachedOramaIndex,
        index: this.readIndex() ?? emptyIndex(),
      };
    }

    try {
      const loaded = await this.loadOramaSnapshot();
      this.installOramaCache(loaded);
      return {
        ...loaded,
        index: this.readIndex() ?? emptyIndex(),
      };
    } catch {
      const { db, tokenizer } = await createOramaDb();
      return {
        db,
        tokenizer,
        index: emptyIndex(),
        warnings: ['orama_snapshot_absent'],
      };
    }
  }

  private async installCurrentOramaProjectionInWriteLock(startState: KbIndexStateSnapshot): Promise<void> {
    this.cachedOramaIndex = null;
    rmSync(this.oramaIndexPath(), { force: true });

    const currentIndex = this.readIndex();
    if (currentIndex === null) {
      try {
        await rebuildTextArtifactsAndPersistRepairState(this, startState);
        return;
      } catch (error: unknown) {
        throw new Error(`KB text search is unavailable: ${errorMessage(error)}`, { cause: error });
      }
    }

    try {
      const preparedProjection = await this.baseProjection.prepareFullSnapshotForCurrentCorpus(currentIndex);
      await this.baseProjection.installFullSnapshotInWriteLock(this.captureCurrentCorpusSnapshot(), preparedProjection);
    } catch (error: unknown) {
      throw new Error(`KB text search is unavailable: ${errorMessage(error)}`, { cause: error });
    }
  }

  private captureTextArtifactsSnapshot(): KbTextArtifactsSnapshot {
    const index = this.readIndex() ?? emptyIndex();
    const notes: KbTextArtifactsSnapshot['notes'] = [];
    const sources: KbTextArtifactsSnapshot['sources'] = [];

    for (const entry of Object.values(index.entries)) {
      if (isNoteEntry(entry)) {
        notes.push({
          entry,
          body: loadKbNote(this.notePath(entry.slug)).body,
        });
        continue;
      }

      if (isSourceEntry(entry)) {
        sources.push({
          entry,
          body: loadKbSource(this.sourcePath(entry.slug)).body,
        });
      }
    }

    return { index, notes, sources };
  }

  /** Install an already-validated index into the in-memory cache. */
  private installIndexCache(validated: KbIndex): KbIndex {
    this.indexCache = { index: validated };
    return validated;
  }

  private installOramaCache(orama: KbCachedOramaIndex): void {
    this.cachedOramaIndex = orama;
  }

  private async loadOramaSnapshot(): Promise<KbCachedOramaIndex> {
    const { db, tokenizer } = await createOramaDb();
    const raw = JSON.parse(readFileSync(this.oramaIndexPath(), 'utf-8')) as RawData;
    load(db, raw);
    return { db, tokenizer };
  }

  private pendingRepairPath(entry: PendingRepairRetryCandidate): string | null {
    if (entry.entryId.startsWith('note:')) {
      return this.notePath(entry.entryId.slice('note:'.length));
    }
    if (entry.entryId.startsWith('source:')) {
      return this.sourcePath(entry.entryId.slice('source:'.length));
    }

    return null;
  }

  private pendingRepairNeedsRetry(): boolean {
    const pendingRepair = readPendingRepairRows(this);
    if (pendingRepair.length === 0) {
      return false;
    }

    const result = pendingRepair.some((entry) => {
      const detectedAt = Date.parse(entry.detectedAt);
      const path = this.pendingRepairPath(entry);
      if (Number.isNaN(detectedAt) || path === null) {
        return false;
      }

      try {
        return statSync(path).mtimeMs > detectedAt;
      } catch {
        return false;
      }
    });
    return result;
  }

  private indexNeedsRebuild(): boolean {
    return detectTextArtifactRebuildInfo(this).needsRebuild;
  }

  private textArtifactsNeedRebuild(state?: KbIndexState | null): boolean {
    const currentState = state === undefined ? this.readIndexStateIfPresent() : state;
    return !isFreshTextSnapshot(currentState) || this.indexNeedsRebuild() || this.pendingRepairNeedsRetry();
  }

  /** Build a vector text snapshot directly from rebuild output, avoiding N re-reads from disk. */
  private snapshotFromRebuildResult(
    result: Awaited<ReturnType<typeof rebuildTextArtifactsAndPersistRepairState>>,
  ): KbTextArtifactsSnapshot {
    const index = this.readIndex() ?? emptyIndex();
    const notes: KbTextArtifactsSnapshot['notes'] = [];
    const sources: KbTextArtifactsSnapshot['sources'] = [];

    for (const note of result.notes) {
      const entry = index.entries[noteEntryId(note.note)];
      if (entry !== undefined && isNoteEntry(entry)) {
        notes.push({ entry, body: note.body });
      }
    }
    for (const source of result.sources) {
      const entry = index.entries[sourceEntryId(source.slug)];
      if (entry !== undefined && isSourceEntry(entry)) {
        sources.push({ entry, body: source.body });
      }
    }

    return { index, notes, sources };
  }
}

export function createKbRuntime(opts: CreateKbRuntimeOptions): KbRuntime {
  return new KbRuntimeImpl(opts);
}

// KbRuntime exposes only the coordinator-facing surface; this bridge reaches the concrete
// write method without widening the public interface.
export function captureKbCorpusSnapshot(kb: KbRuntime): KbCorpusPublication['snapshot'] {
  const runtime = kb as KbRuntime & {
    captureCurrentCorpusSnapshot?: () => KbCorpusPublication['snapshot'];
  };
  if (typeof runtime.captureCurrentCorpusSnapshot !== 'function') {
    throw new Error('KB runtime does not expose corpus snapshot capture.');
  }
  return runtime.captureCurrentCorpusSnapshot();
}

// KbRuntime exposes only the coordinator-facing surface; this bridge reaches the concrete
// write method without widening the public interface.
export function setMutationLockProjectionDispatchMode(kb: KbRuntime, mode: 'delta' | 'full'): void {
  const runtime = kb as KbRuntime & {
    setMutationLockProjectionDispatchMode?: (nextMode: 'delta' | 'full') => void;
  };
  if (typeof runtime.setMutationLockProjectionDispatchMode !== 'function') {
    throw new Error('KB runtime does not expose mutation-lock projection dispatch control.');
  }
  runtime.setMutationLockProjectionDispatchMode(mode);
}

// KbRuntime exposes only the coordinator-facing surface; this bridge reaches the concrete
// write method without widening the public interface.
export function writeEntityGraphLocked(kb: KbRuntime, graph: EntityGraph): void {
  const runtime = kb as KbRuntime & {
    writeEntityGraphLocked?: (nextGraph: EntityGraph) => void;
  };
  if (typeof runtime.writeEntityGraphLocked !== 'function') {
    throw new Error('KB runtime does not expose lock-held entity graph writes.');
  }
  runtime.writeEntityGraphLocked(graph);
}
