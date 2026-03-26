import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, save, type RawData } from '@orama/orama';
import { errorMessage, isNoEntryError, isRecord, isStringArray } from '../shared/mcp-utils.js';
import { loadKbLanceDb } from './lancedb-runtime.js';
import {
  createOramaDb,
  type KbOramaDb,
  type KbOramaTokenizer,
} from './orama-factory.js';
import { rebuildTextArtifacts } from './text-artifacts.js';
import type { KbIndex, KbLanceDbAdapter } from './types.js';

const INDEX_STATE_FILE = 'index-state.json';
const INDEX_FILE = 'index.json';
const ORAMA_INDEX_FILE = 'orama-index.json';
const CURATE_STATE_FILE = 'curate-state.json';

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
  persistIndex(index: KbIndex): KbIndex;
  writeIndex(index: KbIndex): KbIndex;
  readOrCreateIndex(): KbIndex;
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
  principlesDir(): string;
  notePath(note: string): string;
  principlePath(principle: string): string;
  curateStatePath(): string;
};

function defaultIndexState(): KbIndexState {
  return { mutationSeq: 0, indexedSeq: 0 };
}

function emptyIndex(): KbIndex {
  return {
    notes: {},
    principles: {},
  };
}

function parseIndex(value: unknown): KbIndex {
  if (!isRecord(value) || !isRecord(value.notes) || !isRecord(value.principles)) {
    throw new Error('Invalid KB index');
  }

  const notes: KbIndex['notes'] = {};
  for (const [note, rawMeta] of Object.entries(value.notes)) {
    if (!isRecord(rawMeta)) {
      throw new Error('Invalid KB index');
    }

    const {
      title,
      tags,
      principles,
      source,
      createdAt,
      updatedAt,
      mutationSeqAtPromote,
    } = rawMeta;
    if (
      typeof title !== 'string'
      || !isStringArray(tags)
      || !isStringArray(principles)
      || !isStringArray(source)
      || typeof createdAt !== 'string'
      || typeof updatedAt !== 'string'
      || (
        mutationSeqAtPromote !== undefined
        && (typeof mutationSeqAtPromote !== 'number' || !Number.isInteger(mutationSeqAtPromote) || mutationSeqAtPromote < 1)
      )
    ) {
      throw new Error('Invalid KB index');
    }

    notes[note] = {
      title,
      tags: [...tags],
      principles: [...principles],
      source: [...source],
      createdAt,
      updatedAt,
      ...(mutationSeqAtPromote === undefined ? {} : { mutationSeqAtPromote }),
    };
  }

  const principles: KbIndex['principles'] = {};
  for (const [name, statement] of Object.entries(value.principles)) {
    if (typeof statement !== 'string') {
      throw new Error('Invalid KB index');
    }
    principles[name] = statement;
  }

  return { notes, principles };
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
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;

  try {
    writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (error: unknown) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

function isFreshTextSnapshot(state: KbIndexState | null): state is KbIndexState {
  return state !== null && state.indexedSeq === state.mutationSeq && state.staleReason === undefined;
}

function assertWithin(root: string, candidate: string, label: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return resolvedCandidate;
  }
  throw new Error(`${label} must stay within ${resolvedRoot}`);
}

export function createKbRuntime({ markdownRoot, runtimeDir }: { markdownRoot: string; runtimeDir: string }): KbRuntime {
  let adapter: KbLanceDbAdapter | null = null;
  let cachedIndex: KbIndex | null = null;
  let cachedIndexLoaded = false;
  let cachedIndexMtime = 0;
  let cachedOramaIndex: KbCachedOramaIndex | null = null;
  let mutationLock: Promise<void> = Promise.resolve();

  function notesDir(): string {
    return join(markdownRoot, 'notes');
  }

  function principlesDir(): string {
    return join(markdownRoot, 'principles');
  }

  function notePath(note: string): string {
    const root = notesDir();
    return assertWithin(root, resolve(root, `${note}.md`), 'KB note path');
  }

  function principlePath(principle: string): string {
    const root = principlesDir();
    return assertWithin(root, resolve(root, `${principle}.md`), 'KB principle path');
  }

  function curateStatePath(): string {
    return join(markdownRoot, CURATE_STATE_FILE);
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

  function installIndexCache(index: KbIndex): KbIndex {
    const normalized = parseIndex(index);
    cachedIndex = normalized;
    cachedIndexLoaded = true;
    cachedIndexMtime = statSync(indexPath()).mtimeMs;
    return normalized;
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
      throw error;
    }
  }

  function readIndexState(): KbIndexState {
    return readIndexStateIfPresent() ?? defaultIndexState();
  }

  function indexNeedsRebuild(): boolean {
    const currentIndexPath = indexPath();
    if (!existsSync(currentIndexPath)) {
      return true;
    }

    try {
      const currentNotesDir = notesDir();
      const currentPrinciplesDir = principlesDir();
      if (!existsSync(currentNotesDir)) {
        return false;
      }

      const indexMtime = cachedIndexMtime || statSync(currentIndexPath).mtimeMs;
      if (statSync(currentNotesDir).mtimeMs > indexMtime) {
        return true;
      }

      if (existsSync(currentPrinciplesDir) && statSync(currentPrinciplesDir).mtimeMs > indexMtime) {
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  function textArtifactsNeedRebuild(): boolean {
    return !isFreshTextSnapshot(readIndexStateIfPresent()) || indexNeedsRebuild();
  }

  async function ensureIndex(): Promise<KbIndex> {
    if (textArtifactsNeedRebuild()) {
      await kbRuntime.withMutationLock(async () => {
        const startSeq = readIndexState().mutationSeq;
        if (!textArtifactsNeedRebuild()) {
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

    if (cachedOramaIndex !== null && !textArtifactsNeedRebuild()) {
      return {
        ...cachedOramaIndex,
        index: kbRuntime.readIndex() ?? emptyIndex(),
      };
    }

    return kbRuntime.withMutationLock(async () => {
      const startSeq = readIndexState().mutationSeq;

      if (textArtifactsNeedRebuild()) {
        try {
          await rebuildTextArtifacts(kbRuntime, startSeq);
        } catch (error: unknown) {
          throw new Error(`KB text search is unavailable: ${errorMessage(error)}`);
        }
      } else if (cachedOramaIndex === null) {
        try {
          installOramaCache(await loadOramaSnapshot());
        } catch {
          try {
            await rebuildTextArtifacts(kbRuntime, startSeq);
          } catch (error: unknown) {
            throw new Error(`KB text search is unavailable: ${errorMessage(error)}`);
          }
        }
      }

      if (cachedOramaIndex === null || textArtifactsNeedRebuild()) {
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
      if (cachedIndexLoaded) {
        return cachedIndex;
      }

      cachedIndexLoaded = true;

      try {
        const raw = readFileSync(indexPath(), 'utf-8');
        cachedIndex = parseIndex(JSON.parse(raw) as unknown);
        cachedIndexMtime = statSync(indexPath()).mtimeMs;
        return cachedIndex;
      } catch (error: unknown) {
        if (isNoEntryError(error)) {
          cachedIndex = null;
          return null;
        }
        throw error;
      }
    },
    persistIndex(index) {
      const normalized = parseIndex(index);
      writeJsonAtomic(indexPath(), normalized);
      return normalized;
    },
    writeIndex(index) {
      return installIndexCache(kbRuntime.persistIndex(index));
    },
    readOrCreateIndex() {
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
      cachedIndex = null;
      cachedIndexLoaded = false;
      cachedIndexMtime = 0;
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
    principlesDir,
    notePath,
    principlePath,
    curateStatePath,
  };

  return kbRuntime;
}
