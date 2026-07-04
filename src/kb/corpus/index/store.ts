import { join } from 'node:path';

import { isNoEntryError } from '../../../infra/fs-errors.js';
import { isRecord, isStringArray } from '../../../infra/json.js';
import type { StoragePort } from '../../../infra/port-types.js';
import type { IdPort } from '../../../runtime/ports.js';
import type { KbIndexState } from '../../contract.js';
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
} from '../../entry-types.js';
import { normalizeCommunityChildren, normalizeCommunityParent } from '../frontmatter.js';
import { writeFileAtomic, type FileAtomicHost } from '../file-atomic.js';
import type { CorpusStructuralKey } from '../structural-key.js';
import {
  assertCommunitySlug,
  assertNonEmptyText,
  assertNoteSlug,
  assertSourceSlug,
  assertWikiSlug,
  parseNonNegativeInteger,
  parseOptionalTrimmedString,
  parsePositiveInteger,
} from '../../validation.js';
import { captureIndexStateSnapshot, type KbIndexStateSnapshot } from '../lanes.js';

export const INDEX_FILE = 'index.json';
export const INDEX_STATE_FILE = 'index-state.json';
const CORPUS_PROJECTION_DIR = 'corpus-projection';
const INDEX_ARTIFACT_DIR = 'index';
const INDEX_STAGING_DIR = 'staging';
const INDEX_COMMITS_DIR = 'commits';
const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);
const RELATIONSHIP_TYPE_SET = new Set<string>(RELATIONSHIP_TYPES);
const RESERVED_ENTITY_META_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function emptyIndex(): KbIndex {
  return {
    entries: {},
    principles: {},
    entityMeta: {},
    relationships: [],
  };
}

function defaultIndexState(): KbIndexState {
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

  const entries: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    entries.push(assertNonEmptyText(value[index], `${field}[${index}]`));
  }
  return entries;
}

function parseEntityType(value: unknown, errorMessageText = 'Invalid KB entity graph'): EntityType {
  if (typeof value !== 'string' || !ENTITY_TYPE_SET.has(value)) {
    throw new Error(errorMessageText);
  }

  return value as EntityType;
}

function parseRelationshipType(value: unknown, errorMessageText = 'Invalid KB entity graph'): RelationshipType {
  if (typeof value !== 'string' || !RELATIONSHIP_TYPE_SET.has(value)) {
    throw new Error(errorMessageText);
  }

  return value as RelationshipType;
}

function parseEntityMetaKey(value: string, errorMessageText: string): string {
  const key = assertNonEmptyText(value, 'entityMeta key');
  if (RESERVED_ENTITY_META_KEYS.has(key)) {
    throw new Error(errorMessageText);
  }
  return key;
}

export function parseEntityMetaMap(
  value: unknown,
  errorMessageText = 'Invalid KB entity graph',
): Record<string, EntityMeta> {
  if (!isRecord(value)) {
    throw new Error(errorMessageText);
  }

  const entityMeta: Record<string, EntityMeta> = {};
  for (const [entityName, rawMeta] of Object.entries(value)) {
    if (!isRecord(rawMeta)) {
      throw new Error(errorMessageText);
    }

    const aliases = rawMeta.aliases;
    entityMeta[parseEntityMetaKey(entityName, errorMessageText)] = {
      type: parseEntityType(rawMeta.type, errorMessageText),
      description: assertNonEmptyText(rawMeta.description, 'entity description'),
      ...(aliases === undefined
        ? {}
        : { aliases: parseNonEmptyStringArray(aliases, `entityMeta.${entityName}.aliases`, errorMessageText) }),
    };
  }
  return entityMeta;
}

export function parseEntityRelationships(
  value: unknown,
  errorMessageText = 'Invalid KB entity graph',
): EntityRelationship[] {
  if (!Array.isArray(value)) {
    throw new Error(errorMessageText);
  }

  const relationships: EntityRelationship[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const rawRelationship = value[index];
    if (!isRecord(rawRelationship)) {
      throw new Error(errorMessageText);
    }

    relationships.push({
      source: assertNonEmptyText(rawRelationship.source, `relationships[${index}].source`),
      target: assertNonEmptyText(rawRelationship.target, `relationships[${index}].target`),
      type: parseRelationshipType(rawRelationship.type, errorMessageText),
      description: assertNonEmptyText(rawRelationship.description, `relationships[${index}].description`),
      evidence: parseNonEmptyStringArray(
        rawRelationship.evidence,
        `relationships[${index}].evidence`,
        errorMessageText,
      ),
    });
  }
  return relationships;
}

function parseEntryIdArray(value: unknown): KbEntryId[] {
  const values = parseStringArray(value);
  const entryIds: KbEntryId[] = [];
  for (const entryId of values) {
    const normalized = parseKbEntryId(entryId);
    if (normalized === null) {
      throw new Error('Invalid KB index');
    }
    entryIds.push(normalized);
  }
  return entryIds;
}

function parseCorpusStructuralKey(value: unknown): CorpusStructuralKey | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('Invalid KB index');
  }

  return {
    entityGraphHash: assertNonEmptyText(value.entityGraphHash, 'structuralKey.entityGraphHash'),
    communityDocsHash: assertNonEmptyText(value.communityDocsHash, 'structuralKey.communityDocsHash'),
  };
}

function normalizeOptionalNonEmptyIndexString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return assertNonEmptyText(value, `KB index entry ${field}`);
}

function parseNoteIndexEntry(entryId: string, value: Record<string, unknown>): NoteEntry {
  const slug = assertNoteSlug(value.slug, 'KB index entry slug');
  if (entryId !== noteEntryId(slug)) {
    throw new Error('Invalid KB index');
  }
  const inputFingerprint = normalizeOptionalNonEmptyIndexString(value.inputFingerprint, 'inputFingerprint');

  return {
    kind: 'note',
    slug,
    title: assertNonEmptyText(value.title, 'KB index entry title'),
    tags: parseStringArray(value.tags),
    principles: parseStringArray(value.principles),
    source: parseStringArray(value.source),
    createdAt: assertNonEmptyText(value.createdAt, 'KB index entry createdAt'),
    updatedAt: assertNonEmptyText(value.updatedAt, 'KB index entry updatedAt'),
    bodyHash: assertNonEmptyText(value.bodyHash, 'KB index entry bodyHash'),
    ...(inputFingerprint === undefined ? {} : { inputFingerprint }),
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
  const inputFingerprint = normalizeOptionalNonEmptyIndexString(value.inputFingerprint, 'inputFingerprint');

  return {
    kind: 'source',
    slug,
    title: assertNonEmptyText(value.title, 'KB index entry title'),
    type: assertNonEmptyText(value.type, 'KB index entry type'),
    tags: parseStringArray(value.tags),
    ...(url === undefined ? {} : { url: assertNonEmptyText(url, 'KB index entry url') }),
    importedAt: assertNonEmptyText(value.importedAt, 'KB index entry importedAt'),
    bodyHash: assertNonEmptyText(value.bodyHash, 'KB index entry bodyHash'),
    ...(inputFingerprint === undefined ? {} : { inputFingerprint }),
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
  const summaryInputFingerprint = normalizeOptionalNonEmptyIndexString(
    value.summaryInputFingerprint,
    'summaryInputFingerprint',
  );

  return {
    kind: 'community',
    slug,
    title: assertNonEmptyText(value.title, 'KB index entry title'),
    level: parseNonNegativeInteger(value.level ?? 0, 'level'),
    members: parseStringArray(value.members),
    ...(parent === undefined ? {} : { parent }),
    ...(children === undefined ? {} : { children }),
    ...(summary === undefined ? {} : { summary }),
    ...(summaryInputFingerprint === undefined ? {} : { summaryInputFingerprint }),
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

function parseIndex(value: unknown): KbIndex {
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
    ...(value.structuralKey === undefined ? {} : { structuralKey: parseCorpusStructuralKey(value.structuralKey) }),
    ...(value.generatedCommunityGeneration === undefined
      ? {}
      : {
          generatedCommunityGeneration: parseNonNegativeInteger(
            value.generatedCommunityGeneration,
            'generatedCommunityGeneration',
          ),
        }),
    ...(value.generatedCommunityDocsHash === undefined
      ? {}
      : {
          generatedCommunityDocsHash: assertNonEmptyText(
            value.generatedCommunityDocsHash,
            'generatedCommunityDocsHash',
          ),
        }),
  };
}

function parseIndexState(value: unknown): KbIndexState {
  if (!isRecord(value)) {
    throw new Error('Invalid KB index state');
  }

  const allowedKeys = new Set(['contentSeq', 'metadataSeq', 'textStaleReason']);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error('Invalid KB index state');
    }
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
  storage: Pick<StoragePort, 'readFileSync' | 'rmSync' | 'mkdirSync' | 'writeFileSync' | 'renameSync'> &
    Partial<Pick<StoragePort, 'existsSync' | 'readdirSync'>>;
  ids: Pick<IdPort, 'uuid'>;
  onStateChange?: (previous: KbIndexStateSnapshot, next: KbIndexStateSnapshot) => void;
  onIndexCorruption?: () => void;
}

export type StagedKbIndexArtifact = {
  readonly commitId: string;
  readonly stagingId: string;
  readonly stagingDir: string;
  readonly indexPath: string;
  readonly index: KbIndex;
};

export type AdoptedKbIndexArtifact = {
  readonly previousIndexPath: string;
  readonly hadPreviousIndex: boolean;
};

export class KbIndexStore {
  private indexCache: { index: KbIndex | null } | null = null;
  private readonly host: FileAtomicHost;

  private readonly options: KbIndexStoreOptions;
  constructor(options: KbIndexStoreOptions) {
    this.options = options;
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

  stageIndexArtifact(index: KbIndex, commitId: string): StagedKbIndexArtifact {
    const normalized = parseIndex(index);
    const stagingId = this.options.ids.uuid();
    const stagingDir = join(this.indexStagingRoot(), stagingId);
    const indexPath = join(stagingDir, INDEX_FILE);
    this.options.storage.rmSync(stagingDir, { recursive: true, force: true });
    this.options.storage.mkdirSync(stagingDir, { recursive: true });
    writeJsonAtomic(this.host, indexPath, normalized);
    return {
      commitId,
      stagingId,
      stagingDir,
      indexPath,
      index: normalized,
    };
  }

  prepareStagedIndexAdoption(staged: Pick<StagedKbIndexArtifact, 'commitId'>): AdoptedKbIndexArtifact {
    const commitDir = this.indexCommitDir(staged.commitId);
    const previousIndexPath = join(commitDir, 'previous-index.json');
    this.options.storage.mkdirSync(commitDir, { recursive: true });
    this.options.storage.rmSync(previousIndexPath, { force: true });

    return { previousIndexPath, hadPreviousIndex: this.fileExists(this.indexPath()) };
  }

  adoptStagedIndexArtifact(
    staged: StagedKbIndexArtifact,
    adoption: AdoptedKbIndexArtifact = this.prepareStagedIndexAdoption(staged),
  ): void {
    if (adoption.hadPreviousIndex) {
      this.options.storage.renameSync(this.indexPath(), adoption.previousIndexPath);
    }
    this.options.storage.renameSync(staged.indexPath, this.indexPath());
    this.options.storage.rmSync(staged.stagingDir, { recursive: true, force: true });
    this.installIndexCache(staged.index);
  }

  rollbackAdoptedIndexArtifact(input: {
    readonly previousIndexPath: string;
    readonly hadPreviousIndex: boolean;
  }): void {
    if (input.hadPreviousIndex) {
      if (this.fileExists(input.previousIndexPath)) {
        this.options.storage.rmSync(this.indexPath(), { force: true });
        this.options.storage.renameSync(input.previousIndexPath, this.indexPath());
      }
    } else {
      this.options.storage.rmSync(this.indexPath(), { force: true });
    }
    this.invalidateIndexCache();
  }

  discardStagedIndexArtifact(staged: Pick<StagedKbIndexArtifact, 'stagingDir'>): void {
    this.options.storage.rmSync(staged.stagingDir, { recursive: true, force: true });
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

  indexCommitRoot(): string {
    return join(this.options.runtimeDir, CORPUS_PROJECTION_DIR, INDEX_ARTIFACT_DIR, INDEX_COMMITS_DIR);
  }

  cleanupIndexStaging(): void {
    this.options.storage.rmSync(this.indexStagingRoot(), { recursive: true, force: true });
  }

  cleanupIndexCommit(commitId: string): void {
    this.options.storage.rmSync(this.indexCommitDir(commitId), { recursive: true, force: true });
  }

  private indexStagingRoot(): string {
    return join(this.options.runtimeDir, CORPUS_PROJECTION_DIR, INDEX_ARTIFACT_DIR, INDEX_STAGING_DIR);
  }

  private indexCommitDir(commitId: string): string {
    return join(this.indexCommitRoot(), commitId);
  }

  private fileExists(path: string): boolean {
    if (this.options.storage.existsSync !== undefined) {
      return this.options.storage.existsSync(path);
    }
    try {
      this.options.storage.readFileSync(path, 'utf-8');
      return true;
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return false;
      }
      throw error;
    }
  }
}
