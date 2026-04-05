import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { errorMessage, isNoEntryError } from '../shared/mcp-utils.js';
import { backendLog } from '../shared/backend-log.js';
import type { KbIndexState, KbRuntime } from './contracts.js';
import {
  isCommunityEntry,
  isNoteEntry,
  isSourceEntry,
  type CommunityEntry,
  type EntryRecord,
  type KbIndex,
  type NoteEntry,
  type SourceEntry,
} from './types.js';

type NoteIndexEntrySource = Omit<NoteEntry, 'kind'>;
type SourceIndexEntrySource = Omit<SourceEntry, 'kind'>;
type CommunityIndexEntrySource = Omit<CommunityEntry, 'kind'>;

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
    related: [...(meta.related ?? [])],
  };

  if (meta.entrySeq !== undefined) {
    entry.entrySeq = meta.entrySeq;
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
    related: [...(meta.related ?? [])],
    ...(meta.entrySeq === undefined ? {} : { entrySeq: meta.entrySeq }),
  };
}

export function buildCommunityIndexEntry(meta: CommunityIndexEntrySource): CommunityEntry {
  return {
    kind: 'community',
    slug: meta.slug,
    title: meta.title,
    level: meta.level,
    members: [...meta.members],
    ...(meta.parent === undefined ? {} : { parent: meta.parent }),
    ...(meta.summary === undefined ? {} : { summary: meta.summary }),
    generatedBy: 'curate',
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

export function writeFileAtomic(filePath: string, payload: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;

  try {
    writeFileSync(tmpPath, payload, 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (error: unknown) {
    rmSync(tmpPath, { force: true });
    throw error;
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
    entries: Object.fromEntries(Object.entries(index.entries).map(([entryId, entry]) => [entryId, cloneEntryRecord(entry)])),
    principles: { ...index.principles },
  };
}

function cloneEntryRecord(entry: EntryRecord): EntryRecord {
  if (isNoteEntry(entry)) {
    return buildNoteIndexEntry(entry);
  }

  if (isSourceEntry(entry)) {
    return buildSourceIndexEntry(entry);
  }

  if (isCommunityEntry(entry)) {
    return buildCommunityIndexEntry(entry);
  }

  throw new Error(`Unsupported KB entry kind: ${(entry as EntryRecord).kind}`);
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
