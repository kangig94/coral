import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { load, save, type RawData } from '@orama/orama';
import { kbRoot } from '../client/paths.js';
import type { CallerContext } from '../execution/request-context.js';
import { errorMessage, isNoEntryError, isRecord, isStringArray } from '../shared/mcp-utils.js';
import { loadKbLanceDb } from './lancedb-runtime.js';
import {
  createOramaDb,
  type KbOramaDb,
  type KbOramaTokenizer,
} from './orama-factory.js';
import { kbRuntimeDir } from './paths.js';
import type { KbContext, KbIndex, KbLanceDbAdapter } from './types.js';

export type KbIndexState = {
  mutationSeq: number;
  indexedSeq: number;
  staleReason?: string;
};

const INDEX_STATE_FILE = 'index-state.json';
const INDEX_FILE = 'index.json';
const ORAMA_INDEX_FILE = 'orama-index.json';

type CachedOramaIndex = {
  db: KbOramaDb;
  tokenizer: KbOramaTokenizer;
};

let adapter: KbLanceDbAdapter | null = null;
let cachedIndex: KbIndex | null = null;
let cachedIndexLoaded = false;
let cachedIndexMtime = 0;
let cachedOramaIndex: CachedOramaIndex | null = null;
let mutationLock: Promise<void> = Promise.resolve();

// Lazy auto-rebuild callback — set by reindex module to avoid circular imports
let autoRebuildFn: ((kb: KbContext, startSeq: number) => Promise<void>) | null = null;

export function setAutoRebuild(fn: (kb: KbContext, startSeq: number) => Promise<void>): void {
  autoRebuildFn = fn;
}

function indexStatePath(): string {
  return join(kbRuntimeDir(), INDEX_STATE_FILE);
}

function indexPath(): string {
  return join(kbRuntimeDir(), INDEX_FILE);
}

function oramaIndexPath(): string {
  return join(kbRuntimeDir(), ORAMA_INDEX_FILE);
}

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

    const { title, tags, principles, source, createdAt, updatedAt } = rawMeta;
    if (
      typeof title !== 'string'
      || !isStringArray(tags)
      || !isStringArray(principles)
      || !isStringArray(source)
      || typeof createdAt !== 'string'
      || typeof updatedAt !== 'string'
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
  const normalizedStaleReason = typeof staleReason === 'string' ? staleReason : undefined;

  return {
    mutationSeq,
    indexedSeq,
    ...(normalizedStaleReason === undefined ? {} : { staleReason: normalizedStaleReason }),
  };
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, filePath);
}

function isFreshTextSnapshot(state: KbIndexState | null): state is KbIndexState {
  return state !== null && state.indexedSeq === state.mutationSeq && state.staleReason === undefined;
}

function installKbIndexCache(index: KbIndex): KbIndex {
  const normalized = parseIndex(index);
  cachedIndex = normalized;
  cachedIndexLoaded = true;
  cachedIndexMtime = statSync(indexPath()).mtimeMs;
  return normalized;
}

function installOramaCache(orama: CachedOramaIndex): void {
  cachedOramaIndex = orama;
}

async function loadOramaSnapshot(): Promise<CachedOramaIndex> {
  const { db, tokenizer } = await createOramaDb();
  const raw = JSON.parse(readFileSync(oramaIndexPath(), 'utf-8')) as RawData;
  load(db, raw);
  return { db, tokenizer };
}

async function rebuildWithMutationLock(kb: KbContext): Promise<void> {
  if (autoRebuildFn === null) {
    throw new Error('KB rebuild helper is not configured.');
  }

  const startSeq = readIndexState().mutationSeq;
  await autoRebuildFn(kb, startSeq);
}

export async function initKb(pluginRoot: string): Promise<void> {
  adapter = null;
  invalidateKbCache();
  mkdirSync(kbRuntimeDir(), { recursive: true });

  try {
    const req = createRequire(join(pluginRoot, 'bridge', 'coral-backend.cjs'));
    const entry = req.resolve('@lancedb/lancedb', { paths: [kbRuntimeDir()] });
    adapter = await loadKbLanceDb(pathToFileURL(entry).href);
  } catch {
    adapter = null;
  }

  if (!isFreshTextSnapshot(readIndexStateIfPresent()) || indexNeedsRebuild()) {
    return;
  }

  try {
    installOramaCache(await loadOramaSnapshot());
  } catch {
    cachedOramaIndex = null;
  }
}

export function getKbContext(ctx: CallerContext): KbContext {
  return {
    projectRoot: ctx.projectRoot,
    kbRoot: kbRoot(),
    adapter,
  };
}

export function readKbIndex(): KbIndex | null {
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
}

/** Check if index needs rebuild: missing, or notes dir modified after index was written. */
function indexNeedsRebuild(): boolean {
  const idxPath = indexPath();
  if (!existsSync(idxPath)) return true;

  try {
    const notesDir = join(kbRoot(), 'notes');
    const principlesDir = join(kbRoot(), 'principles');
    if (!existsSync(notesDir)) return false; // no notes, nothing to index

    const idxMtime = cachedIndexMtime || statSync(idxPath).mtimeMs;
    const notesMtime = statSync(notesDir).mtimeMs;
    if (notesMtime > idxMtime) return true;

    if (existsSync(principlesDir)) {
      const princMtime = statSync(principlesDir).mtimeMs;
      if (princMtime > idxMtime) return true;
    }

    return false;
  } catch {
    return false; // fail-open: don't rebuild on stat errors
  }
}

/** Ensure index is fresh before reading. Auto-rebuilds if missing or stale. */
export async function ensureKbIndex(kb: KbContext): Promise<KbIndex> {
  if (indexNeedsRebuild() && autoRebuildFn) {
    await withKbMutationLock(async () => {
      if (!indexNeedsRebuild()) {
        return;
      }

      await rebuildWithMutationLock(kb);
    });
  }

  return readKbIndex() ?? emptyIndex();
}

export async function ensureOramaIndex(kb: KbContext): Promise<{
  db: KbOramaDb;
  tokenizer: KbOramaTokenizer;
  index: KbIndex;
}> {
  await ensureKbIndex(kb);

  if (cachedOramaIndex !== null && isFreshTextSnapshot(readIndexStateIfPresent()) && !indexNeedsRebuild()) {
    return {
      ...cachedOramaIndex,
      index: readKbIndex() ?? emptyIndex(),
    };
  }

  return withKbMutationLock(async () => {
    if (indexNeedsRebuild()) {
      try {
        await rebuildWithMutationLock(kb);
      } catch (error: unknown) {
        throw new Error(`KB text search is unavailable: ${errorMessage(error)}`);
      }
    } else if (!isFreshTextSnapshot(readIndexStateIfPresent())) {
      try {
        await rebuildWithMutationLock(kb);
      } catch (error: unknown) {
        throw new Error(`KB text search is unavailable: ${errorMessage(error)}`);
      }
    } else if (cachedOramaIndex === null) {
      try {
        installOramaCache(await loadOramaSnapshot());
      } catch {
        try {
          await rebuildWithMutationLock(kb);
        } catch (error: unknown) {
          throw new Error(`KB text search is unavailable: ${errorMessage(error)}`);
        }
      }
    }

    if (cachedOramaIndex === null || !isFreshTextSnapshot(readIndexStateIfPresent())) {
      throw new Error('KB text search is unavailable: a fresh text snapshot could not be installed.');
    }

    return {
      ...cachedOramaIndex,
      index: readKbIndex() ?? emptyIndex(),
    };
  });
}

export function persistKbIndex(index: KbIndex): KbIndex {
  const normalized = parseIndex(index);
  writeJsonAtomic(indexPath(), normalized);
  return normalized;
}

export function writeKbIndex(index: KbIndex): KbIndex {
  return installKbIndexCache(persistKbIndex(index));
}

export function readOrCreateKbIndex(): KbIndex {
  return readKbIndex() ?? emptyIndex();
}

export function readIndexStateIfPresent(): KbIndexState | null {
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

export function readIndexState(): KbIndexState {
  return readIndexStateIfPresent() ?? defaultIndexState();
}

export function writeIndexState(state: KbIndexState): void {
  writeJsonAtomic(indexStatePath(), state);
}

export async function withKbMutationLock<T>(fn: () => Promise<T> | T): Promise<T> {
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
}

export function recordMutationCommitted(): KbIndexState {
  const state = readIndexState();
  const nextState = { ...state, mutationSeq: state.mutationSeq + 1 };
  writeIndexState(nextState);
  return nextState;
}

export function recordIndexSyncSuccess(): KbIndexState {
  const state = readIndexState();
  const nextState: KbIndexState = {
    mutationSeq: state.mutationSeq,
    indexedSeq: state.mutationSeq,
  };
  writeIndexState(nextState);
  return nextState;
}

export function recordIndexSyncFailure(reason: string): KbIndexState {
  const state = readIndexState();
  const nextState: KbIndexState = {
    mutationSeq: state.mutationSeq,
    indexedSeq: state.indexedSeq,
    staleReason: reason,
  };
  writeIndexState(nextState);
  return nextState;
}

export function recordReindexSuccess(startSeq: number): KbIndexState {
  const state = readIndexState();
  if (state.mutationSeq !== startSeq) {
    return state;
  }

  const nextState: KbIndexState = {
    mutationSeq: state.mutationSeq,
    indexedSeq: startSeq,
  };
  writeIndexState(nextState);
  return nextState;
}

export function persistOramaSnapshot(db: KbOramaDb): void {
  const snapshot = save(db) as unknown as RawData;
  writeJsonAtomic(oramaIndexPath(), snapshot);
}

export function installRebuiltKbArtifacts(index: KbIndex, orama: CachedOramaIndex): KbIndex {
  const normalized = installKbIndexCache(index);
  installOramaCache(orama);
  return normalized;
}

export function invalidateTextSnapshot(reason: string): KbIndexState {
  const nextState = recordIndexSyncFailure(reason);
  cachedOramaIndex = null;
  rmSync(oramaIndexPath(), { force: true });
  return nextState;
}

export function invalidateKbCache(): void {
  cachedIndex = null;
  cachedIndexLoaded = false;
  cachedIndexMtime = 0;
  cachedOramaIndex = null;
}
