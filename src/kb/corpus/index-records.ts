import {
  type EntityMeta,
  type EntityRelationship,
  type CommunityEntry,
  type EntryRecord,
  type KbIndex,
  type NoteEntry,
  type SourceEntry,
  type WikiEntry,
  isCommunityEntry,
  isNoteEntry,
  isSourceEntry,
  isWikiEntry,
} from '../entry-types.js';

type NoteIndexEntrySource = Omit<NoteEntry, 'kind'>;
type SourceIndexEntrySource = Omit<SourceEntry, 'kind'>;
type CommunityIndexEntrySource = Omit<CommunityEntry, 'kind'>;
type WikiIndexEntrySource = Omit<WikiEntry, 'kind'>;

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

export function buildWikiIndexEntry(meta: WikiIndexEntrySource): WikiEntry {
  return {
    kind: 'wiki',
    slug: meta.slug,
    title: meta.title,
    tags: [...meta.tags],
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    knowledge: [...meta.knowledge],
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

  const entries: KbIndex['entries'] = {};
  for (const [entryId, entry] of Object.entries(index.entries)) {
    entries[entryId] = cloneEntryRecord(entry);
  }
  const relationships: EntityRelationship[] = [];
  for (const relationship of index.relationships) {
    relationships.push(cloneEntityRelationship(relationship));
  }

  return {
    entries,
    principles: { ...index.principles },
    entityMeta: cloneEntityMetaRecord(index.entityMeta),
    relationships,
  };
}

export function cloneEntityMetaRecord(entityMeta: Record<string, EntityMeta>): Record<string, EntityMeta> {
  const cloned: Record<string, EntityMeta> = {};
  for (const [entity, meta] of Object.entries(entityMeta)) {
    cloned[entity] = {
      type: meta.type,
      description: meta.description,
      ...(meta.aliases === undefined ? {} : { aliases: [...meta.aliases] }),
    };
  }
  return cloned;
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

  if (isWikiEntry(entry)) {
    return buildWikiIndexEntry(entry);
  }

  throw new Error(`Unsupported KB entry kind: ${(entry as EntryRecord).kind}`);
}
