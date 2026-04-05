import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { errorMessage } from '../shared/mcp-utils.js';
import { backendLog } from '../shared/backend-log.js';
import type { KbIndexMutationLane, KbIndexState, KbRuntime } from './contracts.js';
import {
  type EntityMeta,
  type EntityRelationship,
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
  const entry: SourceEntry = {
    kind: 'source',
    slug: meta.slug,
    title: meta.title,
    type: meta.type,
    tags: [...meta.tags],
    importedAt: meta.importedAt,
    related: [...(meta.related ?? [])],
  };

  if (meta.url !== undefined) {
    entry.url = meta.url;
  }
  if (meta.entrySeq !== undefined) {
    entry.entrySeq = meta.entrySeq;
  }

  return entry;
}

export function buildCommunityIndexEntry(meta: CommunityIndexEntrySource): CommunityEntry {
  const entry: CommunityEntry = {
    kind: 'community',
    slug: meta.slug,
    title: meta.title,
    level: meta.level,
    members: [...meta.members],
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };

  if (meta.parent !== undefined) {
    entry.parent = meta.parent;
  }
  if (meta.children !== undefined) {
    entry.children = [...meta.children];
  }
  if (meta.summary !== undefined) {
    entry.summary = meta.summary;
  }

  return entry;
}

export function writeFileAtomic(filePath: string, payload: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

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

function cloneEntityMetaRecord(entityMeta: Record<string, EntityMeta>): Record<string, EntityMeta> {
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

function cloneEntityRelationship(relationship: EntityRelationship): EntityRelationship {
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

/**
 * Clone the current index, apply the updater, and write it back.
 * If no index exists on disk, updater receives an empty index.
 * @precondition Caller already holds `rt.withMutationLock()`.
 */
export function commitIndexUpdate(
  rt: Pick<KbRuntime, 'readIndex' | 'writeIndex'>,
  updater: (index: KbIndex) => void,
): void {
  const nextIndex = cloneKbIndex(rt.readIndex());
  updater(nextIndex);
  rt.writeIndex(nextIndex);
}

function recordMutation(
  rt: Pick<KbRuntime, 'recordMutationCommitted'>,
  lane: KbIndexMutationLane,
  reason: string,
): KbIndexState {
  return rt.recordMutationCommitted(lane, reason);
}

export function recordContentMutation(rt: Pick<KbRuntime, 'recordMutationCommitted'>, reason: string): KbIndexState {
  return recordMutation(rt, 'content', reason);
}

export function recordMetadataMutation(rt: Pick<KbRuntime, 'recordMutationCommitted'>, reason: string): KbIndexState {
  return recordMutation(rt, 'metadata', reason);
}

export function recordContentAndMetadataMutation(
  rt: Pick<KbRuntime, 'recordMutationCommitted'>,
  reason: string,
): KbIndexState {
  return recordMutation(rt, 'both', reason);
}

export function markTextIndexStale(invalidate: (reason: string) => KbIndexState, reason: string): void {
  try {
    invalidate(reason);
  } catch (error: unknown) {
    backendLog.warn(`markTextIndexStale: ${errorMessage(error)}`);
  }
}
