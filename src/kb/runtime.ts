import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { load, save, type RawData } from '@orama/orama';
import { errorMessage, isNoEntryError, isRecord, isStringArray } from '../shared/utils.js';
import { backendLog } from '../shared/backend-log.js';
import { CURATE_STATE_FILE, readCurateState, type PendingRepair } from './curate/state.js';
import type {
  KbCachedOramaIndex,
  KbIndexMutationLane,
  KbIndexState,
  KbRuntime,
  KbVectorLease,
  KbVectorSpecState,
  KbVectorTextSnapshot,
} from './contracts.js';
import { normalizeCommunityChildren, normalizeCommunityParent } from './frontmatter.js';
import { cloneKbIndex, writeFileAtomic } from './mutation-helpers.js';
import { createOramaDb } from './orama-factory.js';
import type { KbOramaDb, KbOramaTokenizer } from './orama-schema.js';
import {
  communityPathFromName,
  communitiesDir as pathsCommunitiesDir,
  notePathFromName,
  notesDir as pathsNotesDir,
  principlePathFromName,
  principlesDir as pathsPrinciplesDir,
  sourceImportStageDir as pathsSourceImportStageDir,
  sourcePathFromName,
  sourcesDir as pathsSourcesDir,
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
  isNoteEntry,
  isSourceEntry,
  noteEntryId,
  parseKbEntryId,
  sourceEntryId,
  type KbIndex,
  type NoteEntry,
  type RelationshipType,
  type SourceEntry,
} from './types.js';
import {
  assertCommunitySlug,
  assertNonEmptyText,
  assertNoteSlug,
  assertSourceSlug,
  parseNonNegativeInteger,
  parseOptionalTrimmedString,
  parsePositiveInteger,
} from './validation.js';
import { resolveEmbeddingProviderConfig } from './vector/embedding.js';
import {
  type ActiveVectorHandleInfo,
  type OpenedVectorStore,
  VectorHandleLifecycle,
} from './vector/handle-lifecycle.js';
import { loadKbNote, loadKbSource } from './read.js';
import { readActiveSnapshotId } from './vector/store.js';
import type { VectorStore } from './vector/contracts.js';
import { runEntrySeqUpgradeGuard } from './entry-seq-guard.js';

const INDEX_STATE_FILE = 'index-state.json';
const INDEX_FILE = 'index.json';
const ORAMA_INDEX_FILE = 'orama-index.json';
export const KB_ENTRYSEQ_MIGRATION_VERSION = 1;
const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);
const RELATIONSHIP_TYPE_SET = new Set<string>(RELATIONSHIP_TYPES);

type PersistedKbIndexState = Omit<KbIndexState, 'mutationSeq' | 'textIndexedSeq'>;
type KbIndexStateSnapshot = Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>;

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
    vector: {
      bySpec: {},
    },
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

  const bySpec: Record<string, KbVectorSpecState> = {};
  const vectorValue = value.vector;
  if (vectorValue !== undefined) {
    const rawBySpec = isRecord(vectorValue) && isRecord(vectorValue.bySpec) ? vectorValue.bySpec : null;
    if (rawBySpec !== null) {
      for (const [specId, rawSpecState] of Object.entries(rawBySpec)) {
        if (!isRecord(rawSpecState)) {
          continue;
        }

        const indexedSeq = rawSpecState.indexedSeq;
        const staleReason = rawSpecState.staleReason;
        const activeSnapshotId = rawSpecState.activeSnapshotId;
        if (typeof indexedSeq !== 'number' || !Number.isInteger(indexedSeq) || indexedSeq < 0) {
          continue;
        }
        if (staleReason !== undefined && typeof staleReason !== 'string') {
          continue;
        }
        if (activeSnapshotId !== undefined && typeof activeSnapshotId !== 'string') {
          continue;
        }

        bySpec[specId] = {
          indexedSeq,
          ...(typeof staleReason === 'string' ? { staleReason } : {}),
          ...(typeof activeSnapshotId === 'string' ? { activeSnapshotId } : {}),
        };
      }
    }
  }

  return withLegacyIndexStateAliases({
    contentSeq,
    metadataSeq,
    ...(typeof textStaleReason === 'string'
      ? { textStaleReason }
      : migratedLegacyState === undefined
        ? {}
        : { textStaleReason: migratedLegacyState }),
    vector: {
      bySpec,
    },
  });
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isFreshTextSnapshot(state: KbIndexState | null): state is KbIndexState {
  return state !== null && state.textStaleReason === undefined;
}

class KbRuntimeImpl implements KbRuntime {
  readonly markdownRoot: string;
  readonly runtimeDir: string;
  vectorStore: VectorStore | null = null;

  private indexCache: { index: KbIndex | null } | null = null;
  private cachedOramaIndex: KbCachedOramaIndex | null = null;
  private mutationLock: Promise<void> = Promise.resolve();
  private readonly vectorLifecycle: VectorHandleLifecycle;
  private upgradeGuardDone = false;
  private pendingRepairCache: { mtime: number; result: boolean } | null = null;

  constructor({ markdownRoot, runtimeDir }: { markdownRoot: string; runtimeDir: string }) {
    this.markdownRoot = markdownRoot;
    this.runtimeDir = runtimeDir;
    this.vectorLifecycle = new VectorHandleLifecycle({
      runtimeDir: this.runtimeDir,
      getVectorStatus: (specId) => this.getVectorStatus(specId),
      syncVectorStore: (store) => {
        this.vectorStore = store;
      },
    });

    mkdirSync(this.runtimeDir, { recursive: true });
    runEntrySeqUpgradeGuard(this);
    this.upgradeGuardDone = true;
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

  curateStatePath(): string {
    return join(this.runtimeDir, CURATE_STATE_FILE);
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

  writeEntityGraph(graph: EntityGraph): void {
    const normalized = parseEntityGraph(graph);
    writeJsonAtomic(this.entityGraphPath(), normalized);
    this.recordMutationCommitted('metadata', 'KB entity graph changed.');

    const currentIndex = this.readIndex();
    if (currentIndex !== null) {
      const nextIndex = cloneKbIndex(currentIndex);
      nextIndex.entityMeta = normalized.entityMeta;
      nextIndex.relationships = normalized.relationships;
      this.writeIndex(nextIndex);
    }
  }

  async initVectorStore(pluginRoot: string): Promise<void> {
    this.vectorLifecycle.setPluginRoot(pluginRoot);
    rmSync(join(this.runtimeDir, 'vec-staging'), { recursive: true, force: true });
    await this.closeVectorStores();
    mkdirSync(this.runtimeDir, { recursive: true });
    if (!this.upgradeGuardDone) {
      runEntrySeqUpgradeGuard(this);
      this.upgradeGuardDone = true;
    }

    if (this.textArtifactsNeedRebuild()) {
      return;
    }

    try {
      this.installOramaCache(await this.loadOramaSnapshot());
    } catch {
      this.cachedOramaIndex = null;
    }

    let desiredSpecId: string | null;
    try {
      desiredSpecId = resolveEmbeddingProviderConfig()?.specId ?? null;
    } catch {
      return;
    }

    if (desiredSpecId === null) {
      return;
    }

    const snapshotId = readActiveSnapshotId(this.runtimeDir, desiredSpecId);
    if (snapshotId === null) {
      return;
    }

    try {
      await this.activateVectorSnapshot(desiredSpecId, snapshotId);
    } catch {
      await this.closeVectorStores();
    }
  }

  async openVectorStore(dbPath: string, handleToken: string): Promise<OpenedVectorStore | null> {
    return this.vectorLifecycle.open(dbPath, handleToken);
  }

  async activateVectorSnapshot(specId: string, snapshotId: string): Promise<void> {
    await this.vectorLifecycle.activate(specId, snapshotId);
  }

  async acquireVectorLease(): Promise<KbVectorLease | null> {
    return this.vectorLifecycle.acquireLease();
  }

  async closeVectorStores(): Promise<void> {
    await this.vectorLifecycle.closeAll();
  }

  getActiveVectorHandleInfo(): ActiveVectorHandleInfo | null {
    return this.vectorLifecycle.getActiveInfo();
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
    writeJsonAtomic(this.indexStatePath(), stripLegacyIndexStateAliases(state));
  }

  recordMutationCommitted(lane: KbIndexMutationLane = 'both', reason?: string): KbIndexState {
    const state = stripLegacyIndexStateAliases(this.readIndexState());
    const nextState = withLegacyIndexStateAliases({
      ...applyMutationLane(state, lane),
      ...(reason === undefined ? {} : { textStaleReason: reason }),
    });
    this.writeIndexState(nextState);
    return nextState;
  }

  recordIndexSyncSuccess(): KbIndexState {
    const state = stripLegacyIndexStateAliases(this.readIndexState());
    const nextState = withLegacyIndexStateAliases({
      contentSeq: state.contentSeq,
      metadataSeq: state.metadataSeq,
      vector: state.vector,
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
      vector: state.vector,
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
      vector: state.vector,
    });
    this.writeIndexState(nextState);
    return nextState;
  }

  recordVectorSyncSuccess(specId: string, startContentSeq: number, snapshotId: string): KbIndexState {
    const state = this.readIndexState();
    if (state.contentSeq !== startContentSeq) {
      return state;
    }

    const nextState: KbIndexState = {
      ...state,
      vector: {
        bySpec: {
          ...state.vector.bySpec,
          [specId]: {
            indexedSeq: startContentSeq,
            activeSnapshotId: snapshotId,
          },
        },
      },
    };
    this.writeIndexState(nextState);
    return nextState;
  }

  recordVectorSyncFailure(specId: string, reason: string, activeSnapshotId?: string): KbIndexState {
    const state = this.readIndexState();
    const current = state.vector.bySpec[specId];
    const nextActiveSnapshotId = activeSnapshotId ?? current?.activeSnapshotId;
    const nextState: KbIndexState = {
      ...state,
      vector: {
        bySpec: {
          ...state.vector.bySpec,
          [specId]: {
            indexedSeq: current?.indexedSeq ?? 0,
            staleReason: reason,
            ...(nextActiveSnapshotId === undefined ? {} : { activeSnapshotId: nextActiveSnapshotId }),
          },
        },
      },
    };
    this.writeIndexState(nextState);
    return nextState;
  }

  getVectorStatus(specId: string): KbVectorSpecState | null {
    return this.readIndexState().vector.bySpec[specId] ?? null;
  }

  async ensureIndex(): Promise<KbIndex> {
    if (this.textArtifactsNeedRebuild()) {
      await this.withMutationLock(async () => {
        if (!this.upgradeGuardDone) {
          runEntrySeqUpgradeGuard(this);
          this.upgradeGuardDone = true;
        }
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
  }> {
    const indexAfterEnsure = await this.ensureIndex();
    // Fast path: index is fresh and Orama cache is valid — skip re-read.
    // ensureIndex() guarantees text artifacts are up-to-date when it returns.
    if (this.cachedOramaIndex !== null && this.indexCache !== null) {
      return {
        ...this.cachedOramaIndex,
        index: indexAfterEnsure,
      };
    }

    return this.withMutationLock(async () => {
      const state = this.readIndexStateIfPresent();
      const startState = captureIndexStateSnapshot(state);

      let needsRebuild = this.textArtifactsNeedRebuild(state);
      if (!needsRebuild && this.cachedOramaIndex === null) {
        try {
          this.installOramaCache(await this.loadOramaSnapshot());
        } catch {
          needsRebuild = true;
        }
      }

      if (needsRebuild) {
        try {
          await rebuildTextArtifactsAndPersistRepairState(this, startState);
        } catch (error: unknown) {
          throw new Error(`KB text search is unavailable: ${errorMessage(error)}`, { cause: error });
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
    });
  }

  async ensureTextArtifactsFreshUnderLock(): Promise<KbVectorTextSnapshot> {
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

    return this.captureVectorTextSnapshot();
  }

  async withMutationLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const previous = this.mutationLock;
    let release!: () => void;
    this.mutationLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await fn();
    } finally {
      release();
    }
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

  private indexPath(): string {
    return join(this.runtimeDir, INDEX_FILE);
  }

  private indexStatePath(): string {
    return join(this.runtimeDir, INDEX_STATE_FILE);
  }

  private oramaIndexPath(): string {
    return join(this.runtimeDir, ORAMA_INDEX_FILE);
  }

  private captureVectorTextSnapshot(): KbVectorTextSnapshot {
    const index = this.readIndex() ?? emptyIndex();
    const notes: KbVectorTextSnapshot['notes'] = [];
    const sources: KbVectorTextSnapshot['sources'] = [];

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

  private pendingRepairPath(entry: PendingRepair): string | null {
    if (entry.entryId.startsWith('note:')) {
      return this.notePath(entry.entryId.slice('note:'.length));
    }
    if (entry.entryId.startsWith('source:')) {
      return this.sourcePath(entry.entryId.slice('source:'.length));
    }

    return null;
  }

  private pendingRepairNeedsRetry(): boolean {
    // Cache the curate-state read to avoid per-request disk I/O.
    // Invalidated when curate-state.json mtime changes (any repair/curate write).
    const curateStatePath = this.curateStatePath();
    let curateStateMtime: number;
    try {
      curateStateMtime = statSync(curateStatePath).mtimeMs;
    } catch {
      return false;
    }
    if (this.pendingRepairCache !== null && this.pendingRepairCache.mtime === curateStateMtime) {
      return this.pendingRepairCache.result;
    }

    const pendingRepair = readCurateState(this).pendingRepair;
    if (pendingRepair === null) {
      this.pendingRepairCache = { mtime: curateStateMtime, result: false };
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
    this.pendingRepairCache = { mtime: curateStateMtime, result };
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
  ): KbVectorTextSnapshot {
    const index = this.readIndex() ?? emptyIndex();
    const notes: KbVectorTextSnapshot['notes'] = [];
    const sources: KbVectorTextSnapshot['sources'] = [];

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

export function createKbRuntime(opts: { markdownRoot: string; runtimeDir: string }): KbRuntime {
  return new KbRuntimeImpl(opts);
}
