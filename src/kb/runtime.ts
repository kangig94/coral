import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { load, save, type RawData } from '@orama/orama';
import { errorMessage, isNoEntryError, isRecord, isStringArray } from '../shared/mcp-utils.js';
import { CURATE_STATE_FILE, readCurateState, type PendingRepair } from './curate-state.js';
import type {
  KbCachedOramaIndex,
  KbIndexState,
  KbRuntime,
  KbVectorLease,
  KbVectorSpecState,
  KbVectorTextSnapshot,
} from './contracts.js';
import { normalizeCommunityParent, rewriteLegacyNoteFrontmatter } from './frontmatter.js';
import { sortedMarkdownEntries } from './markdown-entries.js';
import { writeFileAtomic } from './mutation-helpers.js';
import { createOramaDb, type KbOramaDb, type KbOramaTokenizer } from './orama-factory.js';
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
  stripMdExt,
} from './paths.js';
import { rebuildTextArtifactsAndPersistRepairState } from './text-artifacts.js';
import {
  communityEntryId,
  isNoteEntry,
  isSourceEntry,
  noteEntryId,
  parseKbEntryId,
  sourceEntryId,
  type CommunityEntry,
  type KbIndex,
  type NoteEntry,
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
import { resolveEmbeddingProviderConfig } from './embedding.js';
import { loadKbNote, loadKbSource } from './read.js';
import {
  createDuckDBVectorStore,
  readActiveSnapshotId,
  vectorAddonPath,
  vectorSnapshotDbPath,
  type VectorStore,
} from './vector-store.js';

const INDEX_STATE_FILE = 'index-state.json';
const INDEX_FILE = 'index.json';
const ORAMA_INDEX_FILE = 'orama-index.json';
export const KB_ENTRYSEQ_MIGRATION_VERSION = 1;

function defaultIndexState(): KbIndexState {
  return {
    mutationSeq: 0,
    textIndexedSeq: 0,
    vector: {
      bySpec: {},
    },
  };
}

function emptyIndex(): KbIndex {
  return {
    entries: {},
    principles: {},
  };
}

type EntrySeqGuardTarget = Pick<KbRuntime, 'notePath' | 'notesDir'>;

function parseStringArray(value: unknown): string[] {
  if (!isStringArray(value)) {
    throw new Error('Invalid KB index');
  }

  return [...value];
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
  if (value.generatedBy !== 'curate') {
    throw new Error('Invalid KB index');
  }

  const parent = normalizeCommunityParent(value.parent);
  const summary = parseOptionalTrimmedString(value.summary, 'summary');

  return {
    kind: 'community',
    slug,
    title: assertNonEmptyText(value.title, 'KB index entry title'),
    level: parseNonNegativeInteger(value.level, 'level'),
    members: parseStringArray(value.members),
    ...(parent === undefined ? {} : { parent }),
    ...(summary === undefined ? {} : { summary }),
    generatedBy: 'curate',
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
      entries[entryId as keyof KbIndex['entries']] = parseNoteIndexEntry(entryId, rawEntry);
      continue;
    }

    if (rawEntry.kind === 'source') {
      entries[entryId as keyof KbIndex['entries']] = parseSourceIndexEntry(entryId, rawEntry);
      continue;
    }

    if (rawEntry.kind === 'community') {
      entries[entryId as keyof KbIndex['entries']] = parseCommunityIndexEntry(entryId, rawEntry);
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

  return { entries, principles };
}

function parseIndexState(value: unknown): KbIndexState {
  if (!isRecord(value)) {
    throw new Error('Invalid KB index state');
  }

  const mutationSeq = value.mutationSeq;
  const textIndexedSeq = value.textIndexedSeq ?? value.indexedSeq;
  const textStaleReason = value.textStaleReason ?? value.staleReason;
  if (typeof mutationSeq !== 'number' || !Number.isInteger(mutationSeq) || mutationSeq < 0) {
    throw new Error('Invalid KB index state');
  }
  if (typeof textIndexedSeq !== 'number' || !Number.isInteger(textIndexedSeq) || textIndexedSeq < 0) {
    throw new Error('Invalid KB index state');
  }
  if (textStaleReason !== undefined && typeof textStaleReason !== 'string') {
    throw new Error('Invalid KB index state');
  }

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

  return {
    mutationSeq,
    textIndexedSeq,
    ...(typeof textStaleReason === 'string' ? { textStaleReason } : {}),
    vector: {
      bySpec,
    },
  };
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isFreshTextSnapshot(state: KbIndexState | null): state is KbIndexState {
  return state !== null && state.textIndexedSeq === state.mutationSeq && state.textStaleReason === undefined;
}

/**
 * Rewrite legacy `mutationSeqAtPromote` frontmatter to `entrySeq`.
 * Idempotent: rewrites only files that still have the legacy key, so
 * a second invocation is a no-op and does not change directory mtimes.
 * This means it cannot cause a rebuild loop even though it runs before
 * the freshness check in `ensureIndex()`.
 */
export function runEntrySeqUpgradeGuard(target: EntrySeqGuardTarget): boolean {
  let changed = false;

  for (const entry of sortedMarkdownEntries(target.notesDir())) {
    const notePath = target.notePath(stripMdExt(entry));
    const raw = readFileSync(notePath, 'utf-8');
    let rewritten: string | null;

    try {
      rewritten = rewriteLegacyNoteFrontmatter(raw);
    } catch {
      continue;
    }

    if (rewritten === null) {
      continue;
    }

    writeFileAtomic(notePath, rewritten);
    changed = true;
  }

  return changed;
}

type OpenedVectorStore = {
  store: VectorStore;
  close(): Promise<void>;
};

type RuntimeVectorHandle = OpenedVectorStore & {
  specId: string;
  snapshotId: string;
  generation: number;
  leaseCount: number;
  retired: boolean;
  closeTimer: NodeJS.Timeout | null;
  closed: boolean;
};

function readVectorDrainTimeoutMs(): number {
  const raw = process.env.CORAL_VECTOR_DRAIN_TIMEOUT_MS;
  if (raw === undefined) {
    return 30_000;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 30_000;
}

class KbRuntimeImpl implements KbRuntime {
  readonly markdownRoot: string;
  readonly runtimeDir: string;
  vectorStore: VectorStore | null = null;

  private indexCache: { index: KbIndex | null; mtime: number } | null = null;
  private cachedOramaIndex: KbCachedOramaIndex | null = null;
  private mutationLock: Promise<void> = Promise.resolve();
  private vectorPluginRoot: string | null = null;
  private activeVectorHandle: RuntimeVectorHandle | null = null;
  private upgradeGuardDone = false;
  private pendingRepairCache: { mtime: number; result: boolean } | null = null;
  private nextVectorGeneration = 1;
  private readonly retiredVectorHandles = new Set<RuntimeVectorHandle>();
  private readonly vectorDrainTimeoutMs = readVectorDrainTimeoutMs();

  constructor({ markdownRoot, runtimeDir }: { markdownRoot: string; runtimeDir: string }) {
    this.markdownRoot = markdownRoot;
    this.runtimeDir = runtimeDir;

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

  async initVectorStore(pluginRoot: string): Promise<void> {
    this.vectorPluginRoot = pluginRoot;
    rmSync(join(this.runtimeDir, 'vec-staging'), { recursive: true, force: true });
    await this.closeVectorStores();
    this.vectorStore = null;
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

    let desiredSpecId: string | null = null;
    try {
      desiredSpecId = resolveEmbeddingProviderConfig()?.specId ?? null;
    } catch {
      desiredSpecId = null;
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
    if (this.vectorPluginRoot === null) {
      return null;
    }

    const sourceAddonPath = vectorAddonPath(this.runtimeDir);
    if (!existsSync(sourceAddonPath)) {
      return null;
    }

    const addonDir = this.vectorHandleDir(handleToken);
    const addonPath = this.vectorHandleAddonPath(handleToken);
    mkdirSync(addonDir, { recursive: true });
    copyFileSync(sourceAddonPath, addonPath);

    const store = createDuckDBVectorStore({
      pluginRoot: this.vectorPluginRoot,
      runtimeDir: this.runtimeDir,
      addonPath,
    });
    if (store === null) {
      rmSync(addonDir, { recursive: true, force: true });
      return null;
    }

    try {
      await store.init(dbPath);
    } catch (error: unknown) {
      await store.close().catch(() => {});
      rmSync(addonDir, { recursive: true, force: true });
      throw error;
    }

    return {
      store,
      async close() {
        await store.close().catch(() => {});
        rmSync(addonDir, { recursive: true, force: true });
      },
    };
  }

  async activateVectorSnapshot(specId: string, snapshotId: string): Promise<void> {
    const opened = await this.openVectorStore(
      vectorSnapshotDbPath(this.runtimeDir, specId, snapshotId),
      this.makeHandleToken(`active-${specId}-${snapshotId}`),
    );
    if (opened === null) {
      throw new Error('KB vector store is unavailable.');
    }

    this.publishVectorHandle({
      ...opened,
      specId,
      snapshotId,
      generation: this.nextVectorGeneration,
      leaseCount: 0,
      retired: false,
      closeTimer: null,
      closed: false,
    });
    this.nextVectorGeneration += 1;
  }

  async acquireVectorLease(): Promise<KbVectorLease | null> {
    const handle = this.activeVectorHandle;
    if (handle === null || handle.closed) {
      return null;
    }

    handle.leaseCount += 1;
    const vectorStatus = this.getVectorStatus(handle.specId);
    let released = false;

    return {
      store: handle.store,
      specId: handle.specId,
      snapshotId: handle.snapshotId,
      generation: handle.generation,
      vectorStatus,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        handle.leaseCount = Math.max(0, handle.leaseCount - 1);
        await this.maybeCloseRetiredVectorHandle(handle);
      },
    };
  }

  async closeVectorStores(): Promise<void> {
    const handles = [
      ...(this.activeVectorHandle === null ? [] : [this.activeVectorHandle]),
      ...this.retiredVectorHandles,
    ];

    this.activeVectorHandle = null;
    this.vectorStore = null;
    this.retiredVectorHandles.clear();

    for (const handle of handles) {
      await this.forceCloseRuntimeVectorHandle(handle).catch(() => {});
    }
  }

  getActiveVectorHandleInfo(): { specId: string; snapshotId: string; generation: number } | null {
    const handle = this.activeVectorHandle;
    if (handle === null || handle.closed) {
      return null;
    }

    return {
      specId: handle.specId,
      snapshotId: handle.snapshotId,
      generation: handle.generation,
    };
  }

  readIndex(): KbIndex | null {
    if (this.indexCache !== null) {
      return this.indexCache.index;
    }

    try {
      const raw = readFileSync(this.indexPath(), 'utf-8');
      let parsed: KbIndex;
      try {
        parsed = parseIndex(JSON.parse(raw) as unknown);
      } catch {
        this.indexCache = { index: null, mtime: 0 };
        this.cachedOramaIndex = null;
        rmSync(this.indexPath(), { force: true });
        return null;
      }
      this.indexCache = { index: parsed, mtime: statSync(this.indexPath()).mtimeMs };
      return parsed;
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        this.indexCache = { index: null, mtime: 0 };
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
      return parseIndexState(JSON.parse(raw) as unknown);
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
    writeJsonAtomic(this.indexStatePath(), state);
  }

  recordMutationCommitted(): KbIndexState {
    const state = this.readIndexState();
    const nextState = { ...state, mutationSeq: state.mutationSeq + 1 };
    this.writeIndexState(nextState);
    return nextState;
  }

  recordIndexSyncSuccess(): KbIndexState {
    const state = this.readIndexState();
    const nextState: KbIndexState = {
      mutationSeq: state.mutationSeq,
      textIndexedSeq: state.mutationSeq,
      vector: state.vector,
    };
    this.writeIndexState(nextState);
    return nextState;
  }

  recordIndexSyncFailure(reason: string): KbIndexState {
    const state = this.readIndexState();
    const nextState: KbIndexState = {
      mutationSeq: state.mutationSeq,
      textIndexedSeq: state.textIndexedSeq,
      textStaleReason: reason,
      vector: state.vector,
    };
    this.writeIndexState(nextState);
    return nextState;
  }

  recordReindexSuccess(startSeq: number): KbIndexState {
    const state = this.readIndexState();
    if (state.mutationSeq !== startSeq) {
      return state;
    }

    const nextState: KbIndexState = {
      mutationSeq: state.mutationSeq,
      textIndexedSeq: startSeq,
      vector: state.vector,
    };
    this.writeIndexState(nextState);
    return nextState;
  }

  recordVectorSyncSuccess(specId: string, startSeq: number, snapshotId: string): KbIndexState {
    const state = this.readIndexState();
    if (state.mutationSeq !== startSeq) {
      return state;
    }

    const nextState: KbIndexState = {
      ...state,
      vector: {
        bySpec: {
          ...state.vector.bySpec,
          [specId]: {
            indexedSeq: startSeq,
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
    const nextState: KbIndexState = {
      ...state,
      vector: {
        bySpec: {
          ...state.vector.bySpec,
          [specId]: {
            indexedSeq: current?.indexedSeq ?? 0,
            staleReason: reason,
            ...(activeSnapshotId === undefined
              ? current?.activeSnapshotId === undefined
                ? {}
                : { activeSnapshotId: current.activeSnapshotId }
              : { activeSnapshotId }),
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
        const startSeq = state?.mutationSeq ?? 0;
        if (!this.textArtifactsNeedRebuild(state)) {
          return;
        }

        await rebuildTextArtifactsAndPersistRepairState(this, startSeq);
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
      const startSeq = state?.mutationSeq ?? 0;

      if (this.textArtifactsNeedRebuild(state)) {
        try {
          await rebuildTextArtifactsAndPersistRepairState(this, startSeq);
        } catch (error: unknown) {
          throw new Error(`KB text search is unavailable: ${errorMessage(error)}`, { cause: error });
        }
      } else if (this.cachedOramaIndex === null) {
        try {
          this.installOramaCache(await this.loadOramaSnapshot());
        } catch {
          try {
            await rebuildTextArtifactsAndPersistRepairState(this, startSeq);
          } catch (error: unknown) {
            throw new Error(`KB text search is unavailable: ${errorMessage(error)}`, { cause: error });
          }
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

  async ensureTextArtifactsFreshUnderLock(startSeq: number): Promise<KbVectorTextSnapshot> {
    if (this.textArtifactsNeedRebuild()) {
      const result = await rebuildTextArtifactsAndPersistRepairState(this, startSeq);
      return this.snapshotFromRebuildResult(result);
    }

    if (this.cachedOramaIndex === null) {
      try {
        this.installOramaCache(await this.loadOramaSnapshot());
      } catch {
        const result = await rebuildTextArtifactsAndPersistRepairState(this, startSeq);
        return this.snapshotFromRebuildResult(result);
      }
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

  private vectorHandleDir(handleToken: string): string {
    return join(this.runtimeDir, 'vec', 'handles', handleToken);
  }

  private vectorHandleAddonPath(handleToken: string): string {
    return join(this.vectorHandleDir(handleToken), 'coral-needle.node');
  }

  private makeHandleToken(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private async forceCloseRuntimeVectorHandle(handle: RuntimeVectorHandle): Promise<void> {
    if (handle.closed) {
      return;
    }

    handle.closed = true;
    if (handle.closeTimer !== null) {
      clearTimeout(handle.closeTimer);
      handle.closeTimer = null;
    }

    if (this.activeVectorHandle?.generation === handle.generation) {
      this.activeVectorHandle = null;
      this.vectorStore = null;
    }

    this.retiredVectorHandles.delete(handle);
    await handle.close();
  }

  private async maybeCloseRetiredVectorHandle(handle: RuntimeVectorHandle): Promise<void> {
    if (!handle.retired || handle.leaseCount !== 0) {
      return;
    }

    await this.forceCloseRuntimeVectorHandle(handle);
  }

  private scheduleRetiredHandleClose(handle: RuntimeVectorHandle): void {
    if (handle.closeTimer !== null || handle.closed) {
      return;
    }

    handle.closeTimer = setTimeout(() => {
      if (handle.closed || handle.leaseCount === 0) {
        void this.maybeCloseRetiredVectorHandle(handle);
        return;
      }

      process.stderr.write(
        `Warning: forcing close of retired KB vector handle after ${this.vectorDrainTimeoutMs}ms drain timeout.\n`,
      );
      void this.forceCloseRuntimeVectorHandle(handle);
    }, this.vectorDrainTimeoutMs);
    handle.closeTimer.unref?.();
  }

  private retireVectorHandle(handle: RuntimeVectorHandle): void {
    handle.retired = true;
    this.retiredVectorHandles.add(handle);
    this.scheduleRetiredHandleClose(handle);
    void this.maybeCloseRetiredVectorHandle(handle);
  }

  private publishVectorHandle(handle: RuntimeVectorHandle): void {
    const previous = this.activeVectorHandle;
    this.activeVectorHandle = handle;
    this.vectorStore = handle.store;
    if (previous !== null && previous.generation !== handle.generation) {
      this.retireVectorHandle(previous);
    }
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
    this.indexCache = { index: validated, mtime: Date.now() };
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

  private dirModifiedAfter(dir: string, threshold: number): boolean {
    try {
      return statSync(dir).mtimeMs > threshold;
    } catch {
      return false;
    }
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
    const curateStatePath = join(this.runtimeDir, 'curate-state.json');
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
    const currentIndexPath = this.indexPath();
    if (!existsSync(currentIndexPath)) {
      return true;
    }

    try {
      const indexMtime = this.indexCache?.mtime || statSync(currentIndexPath).mtimeMs;
      return [this.notesDir(), this.principlesDir(), this.sourcesDir(), this.communitiesDir()].some((dir) =>
        this.dirModifiedAfter(dir, indexMtime),
      );
    } catch {
      return false;
    }
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
