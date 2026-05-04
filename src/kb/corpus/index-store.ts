import { join } from 'node:path';

import { isNoEntryError } from '../../infra/fs-errors.js';
import { isRecord, isStringArray } from '../../infra/json.js';
import type { StoragePort } from '../../infra/port-types.js';
import type { IdPort } from '../../runtime/ports.js';
import type { KbIndexState } from '../contract.js';
import {
  communityEntryId,
  type CommunityEntry,
  type EntityMeta,
  type EntityRelationship,
  type EntityType,
  ENTITY_TYPES,
  type KbEntryId,
  type KbIndex,
  type NoteEntry,
  noteEntryId,
  parseKbEntryId,
  type RelationshipType,
  RELATIONSHIP_TYPES,
  type SourceEntry,
  sourceEntryId,
  type WikiEntry,
  wikiEntryId,
} from '../entry-types.js';
import { normalizeCommunityChildren, normalizeCommunityParent } from './frontmatter.js';
import { writeFileAtomic, type FileAtomicHost } from './file-atomic.js';
import {
  assertCommunitySlug,
  assertNonEmptyText,
  assertNoteSlug,
  assertSourceSlug,
  assertWikiSlug,
  parseNonNegativeInteger,
  parseOptionalTrimmedString,
  parsePositiveInteger,
} from '../validation.js';
import { captureIndexStateSnapshot, type KbIndexStateSnapshot } from './lanes.js';

export const INDEX_FILE = 'index.json';
export const INDEX_STATE_FILE = 'index-state.json';
const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);
const RELATIONSHIP_TYPE_SET = new Set<string>(RELATIONSHIP_TYPES);

export function emptyIndex(): KbIndex {
  return {
    entries: {},
    principles: {},
    entityMeta: {},
    relationships: [],
  };
}

export function defaultIndexState(): KbIndexState {
  return {
    contentSeq: 0,
    metadataSeq: 0,
  };
}

export function isFreshTextSnapshot(state: KbIndexState | null): state is KbIndexState {
  return state !== null && state.textStaleReason === undefined;
}

export function writeJsonAtomic(host: FileAtomicHost, filePath: string, value: unknown): void {
  writeFileAtomic(host, filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseStringArray(value: unknown): string[] {
  if (!isStringArray(value)) {
    throw new Error('Invalid KB index');
  }

  return [...value];
}

function parseNonEmptyStringArray(
  value: unknown,
  field: string,
  errorMessageText = 'Invalid KB entity graph',
): string[] {
  if (!isStringArray(value)) {
    throw new Error(errorMessageText);
  }

  return value.map((entry, index) => assertNonEmptyText(entry, `${field}[${index}]`));
}

export function parseEntityType(value: unknown, errorMessageText = 'Invalid KB entity graph'): EntityType {
  if (typeof value !== 'string' || !ENTITY_TYPE_SET.has(value)) {
    throw new Error(errorMessageText);
  }

  return value as EntityType;
}

export function parseRelationshipType(value: unknown, errorMessageText = 'Invalid KB entity graph'): RelationshipType {
  if (typeof value !== 'string' || !RELATIONSHIP_TYPE_SET.has(value)) {
    throw new Error(errorMessageText);
  }

  return value as RelationshipType;
}

export function parseEntityMetaMap(
  value: unknown,
  errorMessageText = 'Invalid KB entity graph',
): Record<string, EntityMeta> {
  if (!isRecord(value)) {
    throw new Error(errorMessageText);
  }

  return Object.fromEntries(
    Object.entries(value).map(([entityName, rawMeta]) => {
      if (!isRecord(rawMeta)) {
        throw new Error(errorMessageText);
      }

      const aliases = rawMeta.aliases;
      return [
        assertNonEmptyText(entityName, 'entityMeta key'),
        {
          type: parseEntityType(rawMeta.type, errorMessageText),
          description: assertNonEmptyText(rawMeta.description, 'entity description'),
          ...(aliases === undefined
            ? {}
            : { aliases: parseNonEmptyStringArray(aliases, `entityMeta.${entityName}.aliases`, errorMessageText) }),
        },
      ];
    }),
  );
}

export function parseEntityRelationships(
  value: unknown,
  errorMessageText = 'Invalid KB entity graph',
): EntityRelationship[] {
  if (!Array.isArray(value)) {
    throw new Error(errorMessageText);
  }

  return value.map((rawRelationship, index) => {
    if (!isRecord(rawRelationship)) {
      throw new Error(errorMessageText);
    }

    return {
      source: assertNonEmptyText(rawRelationship.source, `relationships[${index}].source`),
      target: assertNonEmptyText(rawRelationship.target, `relationships[${index}].target`),
      type: parseRelationshipType(rawRelationship.type, errorMessageText),
      description: assertNonEmptyText(rawRelationship.description, `relationships[${index}].description`),
      evidence: parseNonEmptyStringArray(
        rawRelationship.evidence,
        `relationships[${index}].evidence`,
        errorMessageText,
      ),
    };
  });
}

function parseEntryIdArray(value: unknown): KbEntryId[] {
  const values = parseStringArray(value);
  return values.map((entryId) => {
    const normalized = parseKbEntryId(entryId);
    if (normalized === null) {
      throw new Error('Invalid KB index');
    }
    return normalized;
  });
}

function parseNoteIndexEntry(entryId: string, value: Record<string, unknown>): NoteEntry {
  const slug = assertNoteSlug(value.slug, 'KB index entry slug');
  if (entryId !== noteEntryId(slug)) {
    throw new Error('Invalid KB index');
  }

  return {
    kind: 'note',
    slug,
    title: assertNonEmptyText(value.title, 'KB index entry title'),
    tags: parseStringArray(value.tags),
    principles: parseStringArray(value.principles),
    source: parseStringArray(value.source),
    createdAt: assertNonEmptyText(value.createdAt, 'KB index entry createdAt'),
    updatedAt: assertNonEmptyText(value.updatedAt, 'KB index entry updatedAt'),
    ...(value.entrySeq !== undefined ? { entrySeq: parsePositiveInteger(value.entrySeq, 'entrySeq') } : {}),
    related: value.related === undefined ? [] : parseEntryIdArray(value.related),
  };
}

function parseSourceIndexEntry(entryId: string, value: Record<string, unknown>): SourceEntry {
  const slug = assertSourceSlug(value.slug, 'KB index entry slug');
  if (entryId !== sourceEntryId(slug)) {
    throw new Error('Invalid KB index');
  }
  const url = value.url;
  if (url !== undefined && typeof url !== 'string') {
    throw new Error('Invalid KB index');
  }

  return {
    kind: 'source',
    slug,
    title: assertNonEmptyText(value.title, 'KB index entry title'),
    type: assertNonEmptyText(value.type, 'KB index entry type'),
    tags: parseStringArray(value.tags),
    ...(url === undefined ? {} : { url: assertNonEmptyText(url, 'KB index entry url') }),
    importedAt: assertNonEmptyText(value.importedAt, 'KB index entry importedAt'),
    ...(value.entrySeq !== undefined ? { entrySeq: parsePositiveInteger(value.entrySeq, 'entrySeq') } : {}),
    related: value.related === undefined ? [] : parseEntryIdArray(value.related),
  };
}

function parseCommunityIndexEntry(entryId: string, value: Record<string, unknown>): CommunityEntry {
  const slug = assertCommunitySlug(value.slug, 'KB index entry slug');
  if (entryId !== communityEntryId(slug)) {
    throw new Error('Invalid KB index');
  }

  const parent = normalizeCommunityParent(value.parent);
  const children = normalizeCommunityChildren(value.children);
  const summary = parseOptionalTrimmedString(value.summary, 'summary');

  return {
    kind: 'community',
    slug,
    title: assertNonEmptyText(value.title, 'KB index entry title'),
    level: parseNonNegativeInteger(value.level ?? 0, 'level'),
    members: parseStringArray(value.members),
    ...(parent === undefined ? {} : { parent }),
    ...(children === undefined ? {} : { children }),
    ...(summary === undefined ? {} : { summary }),
    createdAt: assertNonEmptyText(value.createdAt, 'KB index entry createdAt'),
    updatedAt: assertNonEmptyText(value.updatedAt, 'KB index entry updatedAt'),
  };
}

function parseWikiIndexEntry(entryId: string, value: Record<string, unknown>): WikiEntry {
  const slug = assertWikiSlug(value.slug, 'KB index entry slug');
  if (entryId !== wikiEntryId(slug)) {
    throw new Error('Invalid KB index');
  }

  return {
    kind: 'wiki',
    slug,
    title: assertNonEmptyText(value.title, 'KB index entry title'),
    tags: parseStringArray(value.tags),
    createdAt: assertNonEmptyText(value.createdAt, 'KB index entry createdAt'),
    updatedAt: assertNonEmptyText(value.updatedAt, 'KB index entry updatedAt'),
    knowledge: parseEntryIdArray(value.knowledge),
  };
}

export function parseIndex(value: unknown): KbIndex {
  if (
    !isRecord(value) ||
    !isRecord(value.entries) ||
    !isRecord(value.principles) ||
    !('entityMeta' in value) ||
    !('relationships' in value)
  ) {
    throw new Error('Invalid KB index');
  }

  const entries: KbIndex['entries'] = {};
  for (const [entryId, rawEntry] of Object.entries(value.entries)) {
    if (!isRecord(rawEntry)) {
      throw new Error('Invalid KB index');
    }

    if (rawEntry.kind === 'note') {
      entries[entryId] = parseNoteIndexEntry(entryId, rawEntry);
      continue;
    }

    if (rawEntry.kind === 'source') {
      entries[entryId] = parseSourceIndexEntry(entryId, rawEntry);
      continue;
    }

    if (rawEntry.kind === 'community') {
      entries[entryId] = parseCommunityIndexEntry(entryId, rawEntry);
      continue;
    }

    if (rawEntry.kind === 'wiki') {
      entries[entryId] = parseWikiIndexEntry(entryId, rawEntry);
      continue;
    }

    throw new Error('Invalid KB index');
  }

  const principles: KbIndex['principles'] = {};
  for (const [name, statement] of Object.entries(value.principles)) {
    if (typeof statement !== 'string') {
      throw new Error('Invalid KB index');
    }
    principles[name] = statement;
  }

  return {
    entries,
    principles,
    entityMeta: parseEntityMetaMap(value.entityMeta, 'Invalid KB index'),
    relationships: parseEntityRelationships(value.relationships, 'Invalid KB index'),
  };
}

export function parseIndexState(value: unknown): KbIndexState {
  if (!isRecord(value)) {
    throw new Error('Invalid KB index state');
  }

  const allowedKeys = new Set(['contentSeq', 'metadataSeq', 'textStaleReason']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error('Invalid KB index state');
  }

  const { contentSeq, metadataSeq, textStaleReason } = value;
  if (typeof contentSeq !== 'number' || !Number.isInteger(contentSeq) || contentSeq < 0) {
    throw new Error('Invalid KB index state');
  }
  if (typeof metadataSeq !== 'number' || !Number.isInteger(metadataSeq) || metadataSeq < 0) {
    throw new Error('Invalid KB index state');
  }
  if (textStaleReason !== undefined && typeof textStaleReason !== 'string') {
    throw new Error('Invalid KB index state');
  }

  return {
    contentSeq,
    metadataSeq,
    ...(typeof textStaleReason === 'string' ? { textStaleReason } : {}),
  };
}

export interface KbIndexStoreOptions {
  runtimeDir: string;
  storage: Pick<StoragePort, 'readFileSync' | 'rmSync' | 'mkdirSync' | 'writeFileSync' | 'renameSync'>;
  ids: Pick<IdPort, 'uuid'>;
  onStateChange?: (previous: KbIndexStateSnapshot, next: KbIndexStateSnapshot) => void;
  onIndexCorruption?: () => void;
}

export class KbIndexStore {
  private indexCache: { index: KbIndex | null } | null = null;
  private readonly host: FileAtomicHost;

  constructor(private readonly options: KbIndexStoreOptions) {
    this.host = { storagePort: options.storage, ids: options.ids };
  }

  readIndex(): KbIndex | null {
    if (this.indexCache !== null) {
      return this.indexCache.index;
    }

    const path = this.indexPath();
    try {
      const raw = this.options.storage.readFileSync(path, 'utf-8');
      let parsed: KbIndex;
      try {
        parsed = parseIndex(JSON.parse(raw) as unknown);
      } catch {
        this.indexCache = { index: null };
        this.options.onIndexCorruption?.();
        this.options.storage.rmSync(path, { force: true });
        return null;
      }
      this.indexCache = { index: parsed };
      return parsed;
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        this.indexCache = { index: null };
        return null;
      }
      throw error;
    }
  }

  persistIndexToDisk(index: KbIndex): KbIndex {
    const normalized = parseIndex(index);
    writeJsonAtomic(this.host, this.indexPath(), normalized);
    return normalized;
  }

  writeIndex(index: KbIndex): KbIndex {
    return this.installIndexCache(this.persistIndexToDisk(index));
  }

  readIndexOrEmpty(): KbIndex {
    return this.readIndex() ?? emptyIndex();
  }

  readIndexStateIfPresent(): KbIndexState | null {
    try {
      const raw = this.options.storage.readFileSync(this.indexStatePath(), 'utf-8');
      const parsedRaw = JSON.parse(raw) as unknown;
      return parseIndexState(parsedRaw);
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return null;
      }
      this.options.storage.rmSync(this.indexStatePath(), { force: true });
      return null;
    }
  }

  readIndexState(): KbIndexState {
    return this.readIndexStateIfPresent() ?? defaultIndexState();
  }

  writeIndexState(state: KbIndexState): void {
    const previousSnapshot = captureIndexStateSnapshot(this.readIndexStateIfPresent());
    const normalizedState = parseIndexState(state);
    writeJsonAtomic(this.host, this.indexStatePath(), normalizedState);
    this.options.onStateChange?.(previousSnapshot, captureIndexStateSnapshot(normalizedState));
  }

  hasIndexCache(): boolean {
    return this.indexCache !== null;
  }

  invalidateIndexCache(): void {
    this.indexCache = null;
  }

  installIndexCache(validated: KbIndex): KbIndex {
    this.indexCache = { index: validated };
    return validated;
  }

  indexPath(): string {
    return join(this.options.runtimeDir, INDEX_FILE);
  }

  indexStatePath(): string {
    return join(this.options.runtimeDir, INDEX_STATE_FILE);
  }
}
