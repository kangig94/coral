import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { errorMessage, isNoEntryError } from '../shared/mcp-utils.js';
import { backendLog } from '../shared/backend-log.js';
import type { KbIndexState } from './runtime.js';
import type { KbRuntime } from './runtime.js';
import { isNoteEntry, type KbIndex, type NoteEntry, type SourceEntry } from './types.js';

type NoteIndexEntrySource = Omit<NoteEntry, 'kind'>;
type SourceIndexEntrySource = Omit<SourceEntry, 'kind'>;

export function buildNoteIndexEntry(meta: NoteIndexEntrySource): NoteEntry {
  const entry: NoteEntry = {
    kind: 'note',
    slug: meta.slug,
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

export function buildSourceIndexEntry(meta: SourceIndexEntrySource): SourceEntry {
  return {
    kind: 'source',
    slug: meta.slug,
    title: meta.title,
    type: meta.type,
    tags: [...meta.tags],
    ...(meta.url === undefined ? {} : { url: meta.url }),
    importedAt: meta.importedAt,
  };
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
      entries: {},
      principles: {},
    };
  }

  return {
    entries: Object.fromEntries(
      Object.entries(index.entries).map(([entryId, entry]) => [
        entryId,
        isNoteEntry(entry) ? buildNoteIndexEntry(entry) : buildSourceIndexEntry(entry),
      ]),
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

export function markTextIndexStale(invalidate: (reason: string) => KbIndexState, reason: string): void {
  try {
    invalidate(reason);
  } catch (error: unknown) {
    backendLog.warn(`markTextIndexStale: ${errorMessage(error)}`);
  }
}
