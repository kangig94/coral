import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { errorMessage, isNoEntryError } from '../shared/mcp-utils.js';
import { backendLog } from '../shared/backend-log.js';
import type { KbIndexState } from './runtime.js';
import type { KbRuntime } from './runtime.js';
import type { KbIndex } from './types.js';

type NoteIndexEntrySource = {
  title: string;
  tags: readonly string[];
  principles: readonly string[];
  source: readonly string[];
  createdAt: string;
  updatedAt: string;
  mutationSeqAtPromote?: number;
};

export function buildNoteIndexEntry(meta: NoteIndexEntrySource): KbIndex['notes'][string] {
  const entry: KbIndex['notes'][string] = {
    title: meta.title,
    tags: [...meta.tags],
    principles: [...meta.principles],
    source: [...meta.source],
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };

  if (meta.mutationSeqAtPromote !== undefined) {
    entry.mutationSeqAtPromote = meta.mutationSeqAtPromote;
  }

  return entry;
}

const ensuredDirs = new Set<string>();

function ensureDir(dir: string): void {
  if (ensuredDirs.has(dir)) {
    return;
  }

  mkdirSync(dir, { recursive: true });
  ensuredDirs.add(dir);
}

export function writeFileAtomic(filePath: string, payload: string): void {
  const dir = dirname(filePath);
  ensureDir(dir);
  const tmpPath = `${filePath}.tmp`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(tmpPath, payload, 'utf-8');
      renameSync(tmpPath, filePath);
      return;
    } catch (error: unknown) {
      rmSync(tmpPath, { force: true });
      if (attempt === 0 && isNoEntryError(error)) {
        ensuredDirs.delete(dir);
        ensureDir(dir);
        continue;
      }

      throw error;
    }
  }
}

export function cloneKbIndex(index: KbIndex | null): KbIndex {
  if (index === null) {
    return {
      notes: {},
      principles: {},
    };
  }

  return {
    notes: Object.fromEntries(
      Object.entries(index.notes).map(([note, meta]) => [note, buildNoteIndexEntry(meta)]),
    ),
    principles: { ...index.principles },
  };
}

/**
 * Clone the current index, apply the updater, write it back, and mark text stale.
 * If no index exists on disk, updater receives an empty index.
 * @precondition Caller already holds `rt.withMutationLock()`.
 */
export function commitIndexUpdate(
  rt: Pick<KbRuntime, 'readIndex' | 'writeIndex' | 'invalidateTextSnapshot'>,
  updater: (index: KbIndex) => void,
  reason: string,
): void {
  const nextIndex = cloneKbIndex(rt.readIndex());
  updater(nextIndex);
  rt.writeIndex(nextIndex);
  markTextIndexStale(rt.invalidateTextSnapshot, reason);
}

export function markTextIndexStale(
  invalidate: (reason: string) => KbIndexState,
  reason: string,
): void {
  try {
    invalidate(reason);
  } catch (error: unknown) {
    backendLog.warn(`markTextIndexStale: ${errorMessage(error)}`);
  }
}
