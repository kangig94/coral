import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load, save, type RawData } from '@orama/orama';
import { errorMessage, isNoEntryError, isRecord, isStringArray } from '../shared/mcp-utils.js';
import { CURATE_STATE_FILE } from './curate-state.js';
import { loadKbLanceDb } from './lancedb-runtime.js';
import { writeFileAtomic } from './mutation-helpers.js';
import {
  createOramaDb,
  type KbOramaDb,
  type KbOramaTokenizer,
} from './orama-factory.js';
import {
  notePathFromName,
  notesDir as pathsNotesDir,
  principlePathFromName,
  principlesDir as pathsPrinciplesDir,
} from './paths.js';
import { rebuildTextArtifacts } from './text-artifacts.js';
import type { KbIndex, KbLanceDbAdapter } from './types.js';

const INDEX_STATE_FILE = 'index-state.json';
const INDEX_FILE = 'index.json';
const ORAMA_INDEX_FILE = 'orama-index.json';

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
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isFreshTextSnapshot(state: KbIndexState | null): state is KbIndexState {
  return state !== null && state.indexedSeq === state.mutationSeq && state.staleReason === undefined;
}

export function createKbRuntime({ markdownRoot, runtimeDir }: { markdownRoot: string; runtimeDir: string }): KbRuntime {
  let adapter: KbLanceDbAdapter | null = null;
  let cachedIndex: KbIndex | null = null;
  let cachedIndexLoaded = false;
  let cachedIndexMtime = 0;
  let cachedOramaIndex: KbCachedOramaIndex | null = null;
  let mutationLock: Promise<void> = Promise.resolve();

  function notesDir(): string {
    return pathsNotesDir(markdownRoot);
  }

  function principlesDir(): string {
    return pathsPrinciplesDir(markdownRoot);
  }

  function notePath(note: string): string {
    return notePathFromName(note, markdownRoot);
  }

  function principlePath(principle: string): string {
    return principlePathFromName(principle, markdownRoot);
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

  /** Install an already-validated index into the in-memory cache. */
  function installIndexCache(validated: KbIndex): KbIndex {
    cachedIndex = validated;
    cachedIndexLoaded = true;
    cachedIndexMtime = Date.now();
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

  function textArtifactsNeedRebuild(state?: KbIndexState | null): boolean {
    const currentState = state === undefined ? readIndexStateIfPresent() : state;
    return !isFreshTextSnapshot(currentState) || indexNeedsRebuild();
  }

  async function ensureIndex(): Promise<KbIndex> {
    if (textArtifactsNeedRebuild()) {
      await kbRuntime.withMutationLock(async () => {
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
