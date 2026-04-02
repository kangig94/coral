import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, save, type RawData } from '@orama/orama';
import { errorMessage, isNoEntryError, isRecord, isStringArray } from '../shared/mcp-utils.js';
import { CURATE_STATE_FILE } from './curate-state.js';
import { normalizeCommunityParent, rewriteLegacyNoteFrontmatter } from './frontmatter.js';
import { loadKbLanceDb } from './lancedb-runtime.js';
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
import { rebuildTextArtifacts, sortedMarkdownEntries } from './text-artifacts.js';
import {
  communityEntryId,
  noteEntryId,
  parseKbEntryId,
  sourceEntryId,
  type CommunityEntry,
  type KbIndex,
  type KbLanceDbAdapter,
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

const INDEX_STATE_FILE = 'index-state.json';
const INDEX_FILE = 'index.json';
const ORAMA_INDEX_FILE = 'orama-index.json';
export const KB_ENTRYSEQ_MIGRATION_VERSION = 1;

export type KbIndexState = {
  mutationSeq: number;
  indexedSeq: number;
  staleReason?: string;
};

export type KbCachedOramaIndex = {
  db: KbOramaDb;
  tokenizer: KbOramaTokenizer;
};

export type KbRuntime = {
  readonly markdownRoot: string;
  readonly runtimeDir: string;
  readonly adapter: KbLanceDbAdapter | null;
  initAdapter(pluginRoot: string): Promise<void>;
  readIndex(): KbIndex | null;
  persistIndexToDisk(index: KbIndex): KbIndex;
  writeIndex(index: KbIndex): KbIndex;
  readIndexOrEmpty(): KbIndex;
  readIndexStateIfPresent(): KbIndexState | null;
  readIndexState(): KbIndexState;
  writeIndexState(state: KbIndexState): void;
  recordMutationCommitted(): KbIndexState;
  recordIndexSyncSuccess(): KbIndexState;
  recordIndexSyncFailure(reason: string): KbIndexState;
  recordReindexSuccess(startSeq: number): KbIndexState;
  ensureIndex(): Promise<KbIndex>;
  ensureOramaIndex(): Promise<{
    db: KbOramaDb;
    tokenizer: KbOramaTokenizer;
    index: KbIndex;
  }>;
  withMutationLock<T>(fn: () => Promise<T> | T): Promise<T>;
  invalidateKbCache(): void;
  invalidateTextSnapshot(reason: string): KbIndexState;
  installRebuiltArtifacts(index: KbIndex, orama: KbCachedOramaIndex): KbIndex;
  persistOramaSnapshot(db: KbOramaDb): void;
  notesDir(): string;
  sourcesDir(): string;
  communitiesDir(): string;
  principlesDir(): string;
  notePath(note: string): string;
  sourcePath(source: string): string;
  communityPath(community: string): string;
  principlePath(principle: string): string;
  sourceImportStageDir(): string;
  curateStatePath(): string;
};

function defaultIndexState(): KbIndexState {
  return { mutationSeq: 0, indexedSeq: 0 };
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
  const indexedSeq = value.indexedSeq;
  const staleReason = value.staleReason;
  if (typeof mutationSeq !== 'number' || !Number.isInteger(mutationSeq) || mutationSeq < 0) {
    throw new Error('Invalid KB index state');
  }
  if (typeof indexedSeq !== 'number' || !Number.isInteger(indexedSeq) || indexedSeq < 0) {
    throw new Error('Invalid KB index state');
  }
  if (staleReason !== undefined && typeof staleReason !== 'string') {
    throw new Error('Invalid KB index state');
  }

  return {
    mutationSeq,
    indexedSeq,
    ...(typeof staleReason === 'string' ? { staleReason } : {}),
  };
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isFreshTextSnapshot(state: KbIndexState | null): state is KbIndexState {
  return state !== null && state.indexedSeq === state.mutationSeq && state.staleReason === undefined;
}

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
  let adapter: KbLanceDbAdapter | null = null;
  let indexCache: { index: KbIndex | null; mtime: number } | null = null;
  let cachedOramaIndex: KbCachedOramaIndex | null = null;
  let mutationLock: Promise<void> = Promise.resolve();

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

  function indexNeedsRebuild(): boolean {
    const currentIndexPath = indexPath();
    if (!existsSync(currentIndexPath)) {
      return true;
    }

    try {
      const indexMtime = indexCache?.mtime || statSync(currentIndexPath).mtimeMs;
      return [notesDir(), principlesDir(), sourcesDir(), communitiesDir()]
        .some((dir) => dirModifiedAfter(dir, indexMtime));
    } catch {
      return false;
    }
  }

  function textArtifactsNeedRebuild(state?: KbIndexState | null): boolean {
    const currentState = state === undefined ? readIndexStateIfPresent() : state;
    return !isFreshTextSnapshot(currentState) || indexNeedsRebuild();
  }

  async function ensureIndex(): Promise<KbIndex> {
    if (textArtifactsNeedRebuild()) {
      await kbRuntime.withMutationLock(async () => {
        runEntrySeqUpgradeGuard(kbRuntime);
        const state = readIndexStateIfPresent();
        const startSeq = state?.mutationSeq ?? 0;
        if (!textArtifactsNeedRebuild(state)) {
          return;
        }

        await rebuildTextArtifacts(kbRuntime, startSeq);
      });
    }

    return kbRuntime.readIndex() ?? emptyIndex();
  }

  async function ensureOramaIndex(): Promise<{
    db: KbOramaDb;
    tokenizer: KbOramaTokenizer;
    index: KbIndex;
  }> {
    await ensureIndex();
    const stateAfterEnsureIndex = readIndexStateIfPresent();

    if (cachedOramaIndex !== null && !textArtifactsNeedRebuild(stateAfterEnsureIndex)) {
      return {
        ...cachedOramaIndex,
        index: kbRuntime.readIndex() ?? emptyIndex(),
      };
    }

    return kbRuntime.withMutationLock(async () => {
      const state = readIndexStateIfPresent();
      const startSeq = state?.mutationSeq ?? 0;

      if (textArtifactsNeedRebuild(state)) {
        try {
          await rebuildTextArtifacts(kbRuntime, startSeq);
        } catch (error: unknown) {
          throw new Error(`KB text search is unavailable: ${errorMessage(error)}`, { cause: error });
        }
      } else if (cachedOramaIndex === null) {
        try {
          installOramaCache(await loadOramaSnapshot());
        } catch {
          try {
            await rebuildTextArtifacts(kbRuntime, startSeq);
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

  async function initAdapter(pluginRoot: string): Promise<void> {
    adapter = null;
    kbRuntime.invalidateKbCache();
    mkdirSync(runtimeDir, { recursive: true });
    runEntrySeqUpgradeGuard(kbRuntime);

    try {
      const req = createRequire(join(pluginRoot, 'bridge', 'coral-backend.cjs'));
      const entry = req.resolve('@lancedb/lancedb', { paths: [runtimeDir] });
      adapter = await loadKbLanceDb(pathToFileURL(entry).href, runtimeDir);
    } catch {
      adapter = null;
    }

    if (textArtifactsNeedRebuild()) {
      return;
    }

    try {
      installOramaCache(await loadOramaSnapshot());
    } catch {
      cachedOramaIndex = null;
    }
  }

  const kbRuntime: KbRuntime = {
    markdownRoot,
    runtimeDir,
    get adapter() {
      return adapter;
    },
    initAdapter,
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
        indexedSeq: state.mutationSeq,
      };
      kbRuntime.writeIndexState(nextState);
      return nextState;
    },
    recordIndexSyncFailure(reason) {
      const state = readIndexState();
      const nextState: KbIndexState = {
        mutationSeq: state.mutationSeq,
        indexedSeq: state.indexedSeq,
        staleReason: reason,
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
        indexedSeq: startSeq,
      };
      kbRuntime.writeIndexState(nextState);
      return nextState;
    },
    ensureIndex,
    ensureOramaIndex,
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

  return kbRuntime;
}
