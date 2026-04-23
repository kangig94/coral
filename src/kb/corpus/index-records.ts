import type {
  EntityMeta,
  EntityRelationship,
  CommunityEntry,
  EntryRecord,
  KbIndex,
  NoteEntry,
  SourceEntry,
} from '../entry-types.js';
import {
  isCommunityEntry,
  isNoteEntry,
  isSourceEntry,
} from '../entry-types.js';

type NoteIndexEntrySource = Omit<NoteEntry, 'kind'>;
type SourceIndexEntrySource = Omit<SourceEntry, 'kind'>;
type CommunityIndexEntrySource = Omit<CommunityEntry, 'kind'>;

export function buildNoteIndexEntry(meta: NoteIndexEntrySource): NoteEntry {
  return {
    kind: 'note',
    slug: meta.slug,
    title: meta.title,
    tags: [...meta.tags],
    principles: [...meta.principles],
    source: [...meta.source],
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    related: [...(meta.related ?? [])],
    ...(meta.entrySeq === undefined ? {} : { entrySeq: meta.entrySeq }),
  };
}

export function buildSourceIndexEntry(meta: SourceIndexEntrySource): SourceEntry {
  return {
    kind: 'source',
    slug: meta.slug,
    title: meta.title,
    type: meta.type,
    tags: [...meta.tags],
    importedAt: meta.importedAt,
    related: [...(meta.related ?? [])],
    ...(meta.url === undefined ? {} : { url: meta.url }),
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
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    ...(meta.parent === undefined ? {} : { parent: meta.parent }),
    ...(meta.children === undefined ? {} : { children: [...meta.children] }),
    ...(meta.summary === undefined ? {} : { summary: meta.summary }),
  };
}

export function cloneKbIndex(index: KbIndex | null): KbIndex {
  if (index === null) {
    return {
      entries: {},
      principles: {},
      entityMeta: {},
      relationships: [],
    };
  }

  return {
    entries: Object.fromEntries(
      Object.entries(index.entries).map(([entryId, entry]) => [entryId, cloneEntryRecord(entry)]),
    ),
    principles: { ...index.principles },
    ...(index.entityMeta === undefined ? {} : { entityMeta: cloneEntityMetaRecord(index.entityMeta) }),
    ...(index.relationships === undefined ? {} : { relationships: index.relationships.map(cloneEntityRelationship) }),
  };
}

export function cloneEntityMetaRecord(entityMeta: Record<string, EntityMeta>): Record<string, EntityMeta> {
  return Object.fromEntries(
    Object.entries(entityMeta).map(([entity, meta]) => [
      entity,
      {
        type: meta.type,
        description: meta.description,
        ...(meta.aliases === undefined ? {} : { aliases: [...meta.aliases] }),
      },
    ]),
  );
}

export function cloneEntityRelationship(relationship: EntityRelationship): EntityRelationship {
  return {
    source: relationship.source,
    target: relationship.target,
    type: relationship.type,
    description: relationship.description,
    evidence: [...relationship.evidence],
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
