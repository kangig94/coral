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
    entrySeq: parsePositiveInteger(value.entrySeq, 'entrySeq'),
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
    entrySeq: parsePositiveInteger(value.entrySeq, 'entrySeq'),
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

export function createKbRuntime({ markdownRoot, runtimeDir }: { markdownRoot: string; runtimeDir: string }): KbRuntime {
  let indexCache: { index: KbIndex | null; mtime: number } | null = null;
  let cachedOramaIndex: KbCachedOramaIndex | null = null;
  let mutationLock: Promise<void> = Promise.resolve();
  let vectorPluginRoot: string | null = null;
  let activeVectorHandle: RuntimeVectorHandle | null = null;
  let upgradeGuardDone = false;
  let nextVectorGeneration = 1;
  const retiredVectorHandles = new Set<RuntimeVectorHandle>();
  const vectorDrainTimeoutMs = readVectorDrainTimeoutMs();

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

  function notesDir(): string {
    return pathsNotesDir(markdownRoot);
  }

  function principlesDir(): string {
    return pathsPrinciplesDir(markdownRoot);
  }

  function communitiesDir(): string {
    return pathsCommunitiesDir(markdownRoot);
  }

  function sourcesDir(): string {
    return pathsSourcesDir(markdownRoot);
  }

  function notePath(note: string): string {
    return notePathFromName(note, markdownRoot);
  }

  function sourcePath(source: string): string {
    return sourcePathFromName(source, markdownRoot);
  }

  function communityPath(community: string): string {
    return communityPathFromName(community, markdownRoot);
  }

  function principlePath(principle: string): string {
    return principlePathFromName(principle, markdownRoot);
  }

  function sourceImportStageDir(): string {
    return pathsSourceImportStageDir(runtimeDir);
  }

  function curateStatePath(): string {
    return join(runtimeDir, CURATE_STATE_FILE);
  }

  function indexPath(): string {
    return join(runtimeDir, INDEX_FILE);
  }

  function indexStatePath(): string {
    return join(runtimeDir, INDEX_STATE_FILE);
  }

  function oramaIndexPath(): string {
    return join(runtimeDir, ORAMA_INDEX_FILE);
  }

  function vectorHandleDir(handleToken: string): string {
    return join(runtimeDir, 'vec', 'handles', handleToken);
  }

  function vectorHandleAddonPath(handleToken: string): string {
    return join(vectorHandleDir(handleToken), 'coral-needle.node');
  }

  function makeHandleToken(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  async function closeOpenedVectorStore(opened: OpenedVectorStore): Promise<void> {
    await opened.close();
  }

  async function openVectorStore(
    dbPath: string,
    handleToken: string,
  ): Promise<{
    store: VectorStore;
    close(): Promise<void>;
  } | null> {
    if (vectorPluginRoot === null) {
      return null;
    }

    const sourceAddonPath = vectorAddonPath(runtimeDir);
    if (!existsSync(sourceAddonPath)) {
      return null;
    }

    const addonDir = vectorHandleDir(handleToken);
    const addonPath = vectorHandleAddonPath(handleToken);
    mkdirSync(addonDir, { recursive: true });
    copyFileSync(sourceAddonPath, addonPath);

    const store = createDuckDBVectorStore({
      pluginRoot: vectorPluginRoot,
      runtimeDir,
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

  async function forceCloseRuntimeVectorHandle(handle: RuntimeVectorHandle): Promise<void> {
    if (handle.closed) {
      return;
    }

    handle.closed = true;
    if (handle.closeTimer !== null) {
      clearTimeout(handle.closeTimer);
      handle.closeTimer = null;
    }

    if (activeVectorHandle?.generation === handle.generation) {
      activeVectorHandle = null;
      kbRuntime.vectorStore = null;
    }

    retiredVectorHandles.delete(handle);
    await closeOpenedVectorStore(handle);
  }

  async function maybeCloseRetiredVectorHandle(handle: RuntimeVectorHandle): Promise<void> {
    if (!handle.retired || handle.leaseCount !== 0) {
      return;
    }

    await forceCloseRuntimeVectorHandle(handle);
  }

  function scheduleRetiredHandleClose(handle: RuntimeVectorHandle): void {
    if (handle.closeTimer !== null || handle.closed) {
      return;
    }

    handle.closeTimer = setTimeout(() => {
      if (handle.closed || handle.leaseCount === 0) {
        void maybeCloseRetiredVectorHandle(handle);
        return;
      }

      process.stderr.write(
        `Warning: forcing close of retired KB vector handle after ${vectorDrainTimeoutMs}ms drain timeout.\n`,
      );
      void forceCloseRuntimeVectorHandle(handle);
    }, vectorDrainTimeoutMs);
    handle.closeTimer.unref?.();
  }

  function retireVectorHandle(handle: RuntimeVectorHandle): void {
    handle.retired = true;
    retiredVectorHandles.add(handle);
    scheduleRetiredHandleClose(handle);
    void maybeCloseRetiredVectorHandle(handle);
  }

  function publishVectorHandle(handle: RuntimeVectorHandle): void {
    const previous = activeVectorHandle;
    activeVectorHandle = handle;
    kbRuntime.vectorStore = handle.store;
    if (previous !== null && previous.generation !== handle.generation) {
      retireVectorHandle(previous);
    }
  }

  async function activateVectorSnapshot(specId: string, snapshotId: string): Promise<void> {
    const opened = await openVectorStore(
      vectorSnapshotDbPath(runtimeDir, specId, snapshotId),
      makeHandleToken(`active-${specId}-${snapshotId}`),
    );
    if (opened === null) {
      throw new Error('KB vector store is unavailable.');
    }

    publishVectorHandle({
      ...opened,
      specId,
      snapshotId,
      generation: nextVectorGeneration,
      leaseCount: 0,
      retired: false,
      closeTimer: null,
      closed: false,
    });
    nextVectorGeneration += 1;
  }

  async function acquireVectorLease(): Promise<KbVectorLease | null> {
    const handle = activeVectorHandle;
    if (handle === null || handle.closed) {
      return null;
    }

    handle.leaseCount += 1;
    const vectorStatus = kbRuntime.getVectorStatus(handle.specId);
    let released = false;

    return {
      store: handle.store,
      specId: handle.specId,
      snapshotId: handle.snapshotId,
      generation: handle.generation,
      vectorStatus,
      async release() {
        if (released) {
          return;
        }
        released = true;
        handle.leaseCount = Math.max(0, handle.leaseCount - 1);
        await maybeCloseRetiredVectorHandle(handle);
      },
    };
  }

  async function closeVectorStores(): Promise<void> {
    const handles = [
      ...(activeVectorHandle === null ? [] : [activeVectorHandle]),
      ...retiredVectorHandles,
    ];

    activeVectorHandle = null;
    kbRuntime.vectorStore = null;
    retiredVectorHandles.clear();

    for (const handle of handles) {
      await forceCloseRuntimeVectorHandle(handle).catch(() => {});
    }
  }

  function captureVectorTextSnapshot(): KbVectorTextSnapshot {
    const index = kbRuntime.readIndex() ?? emptyIndex();
    const notes: KbVectorTextSnapshot['notes'] = [];
    const sources: KbVectorTextSnapshot['sources'] = [];

    for (const entry of Object.values(index.entries)) {
      if (isNoteEntry(entry)) {
        notes.push({
          entry,
          body: loadKbNote(kbRuntime.notePath(entry.slug)).body,
        });
        continue;
      }

      if (isSourceEntry(entry)) {
        sources.push({
          entry,
          body: loadKbSource(kbRuntime.sourcePath(entry.slug)).body,
        });
      }
    }

    return { index, notes, sources };
  }

  /** Install an already-validated index into the in-memory cache. */
  function installIndexCache(validated: KbIndex): KbIndex {
    indexCache = { index: validated, mtime: Date.now() };
    return validated;
  }

  function installOramaCache(orama: KbCachedOramaIndex): void {
    cachedOramaIndex = orama;
  }

  async function loadOramaSnapshot(): Promise<KbCachedOramaIndex> {
    const { db, tokenizer } = await createOramaDb();
    const raw = JSON.parse(readFileSync(oramaIndexPath(), 'utf-8')) as RawData;
    load(db, raw);
    return { db, tokenizer };
  }

  function readIndexStateIfPresent(): KbIndexState | null {
    try {
      const raw = readFileSync(indexStatePath(), 'utf-8');
      return parseIndexState(JSON.parse(raw) as unknown);
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return null;
      }
      // Corrupt index-state.json: delete and return null (same as missing).
      // The next mutation or rebuild will recreate it from defaultIndexState().
      rmSync(indexStatePath(), { force: true });
      return null;
    }
  }

  function readIndexState(): KbIndexState {
    return readIndexStateIfPresent() ?? defaultIndexState();
  }

  function dirModifiedAfter(dir: string, threshold: number): boolean {
    try {
      return statSync(dir).mtimeMs > threshold;
    } catch {
      return false;
    }
  }

  function pendingRepairPath(entry: PendingRepair): string | null {
    if (entry.entryId.startsWith('note:')) {
      return notePath(entry.entryId.slice('note:'.length));
    }
    if (entry.entryId.startsWith('source:')) {
      return sourcePath(entry.entryId.slice('source:'.length));
    }

    return null;
  }

  let pendingRepairCache: { mtime: number; result: boolean } | null = null;

  function pendingRepairNeedsRetry(): boolean {
    // Cache the curate-state read to avoid per-request disk I/O.
    // Invalidated when curate-state.json mtime changes (any repair/curate write).
    const curateStatePath = join(runtimeDir, 'curate-state.json');
    let curateStateMtime: number;
    try {
      curateStateMtime = statSync(curateStatePath).mtimeMs;
    } catch {
      return false;
    }
    if (pendingRepairCache !== null && pendingRepairCache.mtime === curateStateMtime) {
      return pendingRepairCache.result;
    }

    const pendingRepair = readCurateState(kbRuntime).pendingRepair;
    if (pendingRepair === null) {
      pendingRepairCache = { mtime: curateStateMtime, result: false };
      return false;
    }

    const result = pendingRepair.some((entry) => {
      const detectedAt = Date.parse(entry.detectedAt);
      const path = pendingRepairPath(entry);
      if (Number.isNaN(detectedAt) || path === null) {
        return false;
      }

      try {
        return statSync(path).mtimeMs > detectedAt;
      } catch {
        return false;
      }
    });
    pendingRepairCache = { mtime: curateStateMtime, result };
    return result;
  }

  function indexNeedsRebuild(): boolean {
    const currentIndexPath = indexPath();
    if (!existsSync(currentIndexPath)) {
      return true;
    }

    try {
      const indexMtime = indexCache?.mtime || statSync(currentIndexPath).mtimeMs;
      return [notesDir(), principlesDir(), sourcesDir(), communitiesDir()].some((dir) =>
        dirModifiedAfter(dir, indexMtime),
      );
    } catch {
      return false;
    }
  }

  function textArtifactsNeedRebuild(state?: KbIndexState | null): boolean {
    const currentState = state === undefined ? readIndexStateIfPresent() : state;
    return !isFreshTextSnapshot(currentState) || indexNeedsRebuild() || pendingRepairNeedsRetry();
  }

  async function ensureIndex(): Promise<KbIndex> {
    if (textArtifactsNeedRebuild()) {
      await kbRuntime.withMutationLock(async () => {
        if (!upgradeGuardDone) {
          runEntrySeqUpgradeGuard(kbRuntime);
          upgradeGuardDone = true;
        }
        const state = readIndexStateIfPresent();
        const startSeq = state?.mutationSeq ?? 0;
        if (!textArtifactsNeedRebuild(state)) {
          return;
        }

        await rebuildTextArtifactsAndPersistRepairState(kbRuntime, startSeq);
      });
    }

    return kbRuntime.readIndex() ?? emptyIndex();
  }

  async function ensureOramaIndex(): Promise<{
    db: KbOramaDb;
    tokenizer: KbOramaTokenizer;
    index: KbIndex;
  }> {
    const indexAfterEnsure = await ensureIndex();
    // Fast path: index is fresh and Orama cache is valid — skip re-read.
    // ensureIndex() guarantees text artifacts are up-to-date when it returns.
    if (cachedOramaIndex !== null && indexCache !== null) {
      return {
        ...cachedOramaIndex,
        index: indexAfterEnsure,
      };
    }

    return kbRuntime.withMutationLock(async () => {
      const state = readIndexStateIfPresent();
      const startSeq = state?.mutationSeq ?? 0;

      if (textArtifactsNeedRebuild(state)) {
        try {
          await rebuildTextArtifactsAndPersistRepairState(kbRuntime, startSeq);
        } catch (error: unknown) {
          throw new Error(`KB text search is unavailable: ${errorMessage(error)}`, { cause: error });
        }
      } else if (cachedOramaIndex === null) {
        try {
          installOramaCache(await loadOramaSnapshot());
        } catch {
          try {
            await rebuildTextArtifactsAndPersistRepairState(kbRuntime, startSeq);
          } catch (error: unknown) {
            throw new Error(`KB text search is unavailable: ${errorMessage(error)}`, { cause: error });
          }
        }
      }

      const stateAfterArtifacts = readIndexStateIfPresent();
      if (cachedOramaIndex === null || textArtifactsNeedRebuild(stateAfterArtifacts)) {
        throw new Error('KB text search is unavailable: a fresh text snapshot could not be installed.');
      }

      return {
        ...cachedOramaIndex,
        index: kbRuntime.readIndex() ?? emptyIndex(),
      };
    });
  }

  /** Build a vector text snapshot directly from rebuild output, avoiding N re-reads from disk. */
  function snapshotFromRebuildResult(result: Awaited<ReturnType<typeof rebuildTextArtifactsAndPersistRepairState>>): KbVectorTextSnapshot {
    const index = kbRuntime.readIndex() ?? emptyIndex();
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

  async function ensureTextArtifactsFreshUnderLock(startSeq: number): Promise<KbVectorTextSnapshot> {
    if (textArtifactsNeedRebuild()) {
      const result = await rebuildTextArtifactsAndPersistRepairState(kbRuntime, startSeq);
      return snapshotFromRebuildResult(result);
    }

    if (cachedOramaIndex === null) {
      try {
        installOramaCache(await loadOramaSnapshot());
      } catch {
        const result = await rebuildTextArtifactsAndPersistRepairState(kbRuntime, startSeq);
        return snapshotFromRebuildResult(result);
      }
    }

    const stateAfterArtifacts = readIndexStateIfPresent();
    if (cachedOramaIndex === null || textArtifactsNeedRebuild(stateAfterArtifacts)) {
      throw new Error('KB text search is unavailable: a fresh text snapshot could not be installed.');
    }

    return captureVectorTextSnapshot();
  }

  async function initVectorStore(pluginRoot: string): Promise<void> {
    vectorPluginRoot = pluginRoot;
    rmSync(join(runtimeDir, 'vec-staging'), { recursive: true, force: true });
    await closeVectorStores();
    kbRuntime.vectorStore = null;
    mkdirSync(runtimeDir, { recursive: true });
    if (!upgradeGuardDone) {
      runEntrySeqUpgradeGuard(kbRuntime);
      upgradeGuardDone = true;
    }

    if (textArtifactsNeedRebuild()) {
      return;
    }

    try {
      installOramaCache(await loadOramaSnapshot());
    } catch {
      cachedOramaIndex = null;
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

    const snapshotId = readActiveSnapshotId(runtimeDir, desiredSpecId);
    if (snapshotId === null) {
      return;
    }

    try {
      await activateVectorSnapshot(desiredSpecId, snapshotId);
    } catch {
      await closeVectorStores();
    }
  }

  const kbRuntime: KbRuntime = {
    markdownRoot,
    runtimeDir,
    vectorStore: null,
    initVectorStore,
    openVectorStore,
    activateVectorSnapshot,
    acquireVectorLease,
    closeVectorStores,
    getActiveVectorHandleInfo() {
      if (activeVectorHandle === null || activeVectorHandle.closed) {
        return null;
      }

      return {
        specId: activeVectorHandle.specId,
        snapshotId: activeVectorHandle.snapshotId,
        generation: activeVectorHandle.generation,
      };
    },
    readIndex() {
      if (indexCache !== null) {
        return indexCache.index;
      }

      try {
        const raw = readFileSync(indexPath(), 'utf-8');
        let parsed: KbIndex;
        try {
          parsed = parseIndex(JSON.parse(raw) as unknown);
        } catch {
          indexCache = { index: null, mtime: 0 };
          cachedOramaIndex = null;
          rmSync(indexPath(), { force: true });
          return null;
        }
        indexCache = { index: parsed, mtime: statSync(indexPath()).mtimeMs };
        return parsed;
      } catch (error: unknown) {
        if (isNoEntryError(error)) {
          indexCache = { index: null, mtime: 0 };
          return null;
        }
        throw error;
      }
    },
    persistIndexToDisk(index) {
      const normalized = parseIndex(index);
      writeJsonAtomic(indexPath(), normalized);
      return normalized;
    },
    writeIndex(index) {
      return installIndexCache(kbRuntime.persistIndexToDisk(index));
    },
    readIndexOrEmpty() {
      return kbRuntime.readIndex() ?? emptyIndex();
    },
    readIndexStateIfPresent,
    readIndexState,
    writeIndexState(state) {
      writeJsonAtomic(indexStatePath(), state);
    },
    async withMutationLock<T>(fn: () => Promise<T> | T): Promise<T> {
      const previous = mutationLock;
      let release!: () => void;
      mutationLock = new Promise<void>((resolve) => {
        release = resolve;
      });

      await previous;

      try {
        return await fn();
      } finally {
        release();
      }
    },
    recordMutationCommitted() {
      const state = readIndexState();
      const nextState = { ...state, mutationSeq: state.mutationSeq + 1 };
      kbRuntime.writeIndexState(nextState);
      return nextState;
    },
    recordIndexSyncSuccess() {
      const state = readIndexState();
      const nextState: KbIndexState = {
        mutationSeq: state.mutationSeq,
        textIndexedSeq: state.mutationSeq,
        vector: state.vector,
      };
      kbRuntime.writeIndexState(nextState);
      return nextState;
    },
    recordIndexSyncFailure(reason) {
      const state = readIndexState();
      const nextState: KbIndexState = {
        mutationSeq: state.mutationSeq,
        textIndexedSeq: state.textIndexedSeq,
        textStaleReason: reason,
        vector: state.vector,
      };
      kbRuntime.writeIndexState(nextState);
      return nextState;
    },
    recordReindexSuccess(startSeq) {
      const state = readIndexState();
      if (state.mutationSeq !== startSeq) {
        return state;
      }

      const nextState: KbIndexState = {
        mutationSeq: state.mutationSeq,
        textIndexedSeq: startSeq,
        vector: state.vector,
      };
      kbRuntime.writeIndexState(nextState);
      return nextState;
    },
    recordVectorSyncSuccess(specId, startSeq, snapshotId) {
      const state = readIndexState();
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
      kbRuntime.writeIndexState(nextState);
      return nextState;
    },
    recordVectorSyncFailure(specId, reason, activeSnapshotId) {
      const state = readIndexState();
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
      kbRuntime.writeIndexState(nextState);
      return nextState;
    },
    getVectorStatus(specId) {
      return readIndexState().vector.bySpec[specId] ?? null;
    },
    ensureIndex,
    ensureOramaIndex,
    ensureTextArtifactsFreshUnderLock,
    invalidateKbCache() {
      indexCache = null;
      cachedOramaIndex = null;
    },
    invalidateTextSnapshot(reason) {
      const nextState = kbRuntime.recordIndexSyncFailure(reason);
      cachedOramaIndex = null;
      rmSync(oramaIndexPath(), { force: true });
      return nextState;
    },
    installRebuiltArtifacts(index, orama) {
      const normalized = installIndexCache(index);
      installOramaCache(orama);
      return normalized;
    },
    persistOramaSnapshot(db) {
      const snapshot = save(db) as unknown as RawData;
      writeJsonAtomic(oramaIndexPath(), snapshot);
    },
    notesDir,
    sourcesDir,
    communitiesDir,
    principlesDir,
    notePath,
    sourcePath,
    communityPath,
    principlePath,
    sourceImportStageDir,
    curateStatePath,
  };

  mkdirSync(runtimeDir, { recursive: true });
  runEntrySeqUpgradeGuard(kbRuntime);
  upgradeGuardDone = true;

  return kbRuntime;
}
