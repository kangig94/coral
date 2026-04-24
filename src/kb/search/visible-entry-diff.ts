import {
  isCommunityEntry,
  isNoteEntry,
  isSourceEntry,
  type CommunityEntry,
  type KbIndex,
  type NoteEntry,
  type SourceEntry,
} from '../entry-types.js';

type SearchVisibleEntry = NoteEntry | SourceEntry | CommunityEntry;

function isSearchVisibleEntry(entry: KbIndex['entries'][string] | undefined): entry is SearchVisibleEntry {
  return entry !== undefined && (isNoteEntry(entry) || isSourceEntry(entry) || isCommunityEntry(entry));
}

function entryFingerprint(entry: SearchVisibleEntry): string {
  if (isNoteEntry(entry)) {
    return JSON.stringify({
      kind: entry.kind,
      slug: entry.slug,
      title: entry.title,
      tags: [...entry.tags],
      principles: [...entry.principles],
      source: [...entry.source],
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      related: [...(entry.related ?? [])],
      entrySeq: entry.entrySeq ?? null,
    });
  }

  if (isSourceEntry(entry)) {
    return JSON.stringify({
      kind: entry.kind,
      slug: entry.slug,
      title: entry.title,
      type: entry.type,
      tags: [...entry.tags],
      url: entry.url ?? null,
      importedAt: entry.importedAt,
      related: [...(entry.related ?? [])],
      entrySeq: entry.entrySeq ?? null,
    });
  }

  return JSON.stringify({
    kind: entry.kind,
    slug: entry.slug,
    title: entry.title,
    level: entry.level,
    members: [...entry.members],
    parent: entry.parent ?? null,
    children: [...(entry.children ?? [])],
    summary: entry.summary ?? null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });
}

export function diffSearchVisibleEntryIds(previous: KbIndex, next: KbIndex): {
  changedEntryIds: string[];
  deletedEntryIds: string[];
} {
  const changedEntryIds = new Set<string>();
  const deletedEntryIds = new Set<string>();
  const entryIds = new Set([
    ...Object.keys(previous.entries),
    ...Object.keys(next.entries),
  ]);

  for (const entryId of entryIds) {
    const previousEntry = previous.entries[entryId];
    const nextEntry = next.entries[entryId];
    const previousVisible = isSearchVisibleEntry(previousEntry) ? previousEntry : undefined;
    const nextVisible = isSearchVisibleEntry(nextEntry) ? nextEntry : undefined;

    if (previousVisible === undefined && nextVisible === undefined) {
      continue;
    }
    if (nextVisible === undefined) {
      deletedEntryIds.add(entryId);
      continue;
    }
    if (previousVisible === undefined || entryFingerprint(previousVisible) !== entryFingerprint(nextVisible)) {
      changedEntryIds.add(entryId);
    }
  }

  return {
    changedEntryIds: [...changedEntryIds].sort(),
    deletedEntryIds: [...deletedEntryIds].sort(),
  };
}
