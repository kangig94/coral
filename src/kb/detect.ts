import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { kbRoot } from '../client/paths.js';
import type { CallerContext } from '../execution/request-context.js';
import { isNoEntryError, isRecord, isStringArray } from '../shared/mcp-utils.js';
import { loadKbLanceDb } from './lancedb-runtime.js';
import { kbRuntimeDir } from './paths.js';
import type { KbContext, KbIndex, KbLanceDbAdapter } from './types.js';

type KbIndexState = {
  mutationSeq: number;
  indexedSeq: number;
  staleReason?: string;
};

const INDEX_STATE_FILE = 'index-state.json';
const INDEX_FILE = 'index.json';

let adapter: KbLanceDbAdapter | null = null;
let cachedIndex: KbIndex | null = null;
let cachedIndexLoaded = false;
let mutationLock: Promise<void> = Promise.resolve();

function indexStatePath(): string {
  return join(kbRuntimeDir(), INDEX_STATE_FILE);
}

function indexPath(): string {
  return join(kbRuntimeDir(), INDEX_FILE);
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

  return {
    mutationSeq,
    indexedSeq,
    ...(staleReason === undefined ? {} : { staleReason }),
  };
}

function writeJsonAtomic(filePath: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, filePath);
}

export async function initKb(pluginRoot: string): Promise<void> {
  adapter = null;
  mkdirSync(kbRuntimeDir(), { recursive: true });

  try {
    const req = createRequire(join(pluginRoot, 'bridge', 'coral-backend.cjs'));
    const entry = req.resolve('@lancedb/lancedb', { paths: [kbRuntimeDir()] });
    adapter = await loadKbLanceDb(pathToFileURL(entry).href);
  } catch {
    adapter = null;
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
    return cachedIndex;
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      cachedIndex = null;
      return null;
    }
    throw error;
  }
}

export function writeKbIndex(index: KbIndex): KbIndex {
  const normalized = parseIndex(index);
  writeJsonAtomic(indexPath(), normalized as unknown as Record<string, unknown>);
  cachedIndex = normalized;
  cachedIndexLoaded = true;
  return normalized;
}

export function readOrCreateKbIndex(): KbIndex {
  return readKbIndex() ?? emptyIndex();
}

export function readIndexState(): KbIndexState {
  try {
    const raw = readFileSync(indexStatePath(), 'utf-8');
    return parseIndexState(JSON.parse(raw) as unknown);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return defaultIndexState();
    }
    throw error;
  }
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

export function invalidateKbCache(): void {
  cachedIndex = null;
  cachedIndexLoaded = false;
}
