import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { insertMultiple } from '@orama/orama';
import { errorMessage } from '../shared/utils.js';
import { backendLog } from '../shared/backend-log.js';
import {
  extractMalformedEntryRepair,
  readCurateState,
  writeCurateState,
  type CurateState,
  type PendingRepair,
} from './curate-state.js';
import {
  deriveNoteIdentity,
  extractBody,
  extractPrincipleStatement,
  extractTitle,
  parseCommunityFrontmatter,
  parseSourceFrontmatter,
} from './frontmatter.js';
import {
  buildCommunityDocuments,
  buildEntityRelationshipGraph,
  computeCommunitySummaryInputFingerprints,
  computeCommunityTopologyFingerprint,
  detectCommunities,
  generateCommunityFiles,
  loadExistingCommunityState,
  parseMembersFromBody,
  parseSummaryFromBody,
} from './community-detection.js';
import { buildCommunityIndexEntry, buildNoteIndexEntry, buildSourceIndexEntry } from './mutation-helpers.js';
import { sortedMarkdownEntries } from './markdown-entries.js';
import { stripMdExt } from './paths.js';
import { loadKbNote } from './read.js';
import { assertCommunitySlug, assertSourceSlug } from './validation.js';
import { createOramaDb, toOramaDocument } from './orama-factory.js';
import type { KbIndexMutationLane, KbIndexState, KbRuntime } from './contracts.js';
import {
  communityEntryId,
  isCommunityEntry,
  noteEntryId,
  sourceEntryId,
  type KbIndex,
  type KbReindexCommunityRecord,
  type KbReindexNoteRecord,
  type KbReindexSourceRecord,
  type ReindexResult,
} from './types.js';

const INDEX_FILE = 'index.json';

type LoadedArtifacts<T> = {
  entries: T[];
  pendingRepair: PendingRepair[];
};

function mergeMutationLane(
  current: KbIndexMutationLane | null,
  next: KbIndexMutationLane | null,
): KbIndexMutationLane | null {
  if (next === null || current === 'both') {
    return current;
  }
  if (current === null || current === next) {
    return next;
  }
  return 'both';
}

function dirModifiedAfter(dir: string, threshold: number): boolean {
  try {
    return statSync(dir).mtimeMs > threshold;
  } catch {
    return false;
  }
}

function fileModifiedAfter(filePath: string, threshold: number): boolean {
  try {
    return statSync(filePath).mtimeMs > threshold;
  } catch {
    return false;
  }
}

export function detectTextArtifactRebuildInfo(
  kb: Pick<
    KbRuntime,
    'runtimeDir' | 'readIndex' | 'notesDir' | 'sourcesDir' | 'communitiesDir' | 'principlesDir' | 'entityGraphPath'
  >,
): {
  needsRebuild: boolean;
  externalMutation: KbIndexMutationLane | null;
} {
  const indexPath = join(kb.runtimeDir, INDEX_FILE);
  if (!existsSync(indexPath)) {
    return {
      needsRebuild: true,
      externalMutation: null,
    };
  }

  try {
    const indexMtime = statSync(indexPath).mtimeMs;
    const currentIndex = kb.readIndex();
    let externalMutation: KbIndexMutationLane | null = null;

    if (!existsSync(kb.entityGraphPath())) {
      if (currentIndex?.entityMeta !== undefined || currentIndex?.relationships !== undefined) {
        externalMutation = mergeMutationLane(externalMutation, 'metadata');
      }
    } else if (fileModifiedAfter(kb.entityGraphPath(), indexMtime)) {
      externalMutation = mergeMutationLane(externalMutation, 'metadata');
    }

    if (dirModifiedAfter(kb.principlesDir(), indexMtime) || dirModifiedAfter(kb.communitiesDir(), indexMtime)) {
      externalMutation = mergeMutationLane(externalMutation, 'metadata');
    }

    if (dirModifiedAfter(kb.notesDir(), indexMtime) || dirModifiedAfter(kb.sourcesDir(), indexMtime)) {
      externalMutation = mergeMutationLane(externalMutation, 'both');
    }

    return {
      needsRebuild: externalMutation !== null,
      externalMutation,
    };
  } catch {
    return {
      needsRebuild: false,
      externalMutation: null,
    };
  }
}

function areCommunityDocumentsFreshForState(
  state: Pick<CurateState, 'communityTopologyHash' | 'communitySummaryTopologyHash' | 'communitySummaryInputFingerprints'>,
  kb: Pick<KbRuntime, 'curateStatePath' | 'notePath' | 'sourcePath'>,
  index: KbIndex,
): boolean {
  const communityEntries = Object.values(index.entries).filter(isCommunityEntry);
  if (communityEntries.length === 0) {
    return true;
  }

  const topologyHash = computeCommunityTopologyFingerprint(index);
  if (state.communityTopologyHash !== topologyHash || state.communitySummaryTopologyHash !== topologyHash) {
    return false;
  }

  try {
    const communities = communityEntries.map((community) => ({
      slug: community.slug,
      title: community.title,
      level: community.level,
      members: community.members,
      ...(community.children === undefined ? {} : { children: community.children }),
      ...(community.summary === undefined ? {} : { summary: community.summary }),
    }));
    const currentFingerprints = computeCommunitySummaryInputFingerprints(communities, kb, index);
    const storedFingerprints = state.communitySummaryInputFingerprints ?? {};
    const currentEntries = Object.entries(currentFingerprints).sort(([left], [right]) => left.localeCompare(right));
    const storedEntries = Object.entries(storedFingerprints)
      .filter(([slug]) => slug in currentFingerprints)
      .sort(([left], [right]) => left.localeCompare(right));

    return (
      currentEntries.length === storedEntries.length &&
      currentEntries.every(
        ([slug, fingerprint], index) =>
          storedEntries[index]?.[0] === slug && storedEntries[index]?.[1] === fingerprint,
      )
    );
  } catch {
    return false;
  }
}

function normalizedCommunitySummaryFingerprints(
  fingerprints: Readonly<Record<string, string>> | undefined,
  communities: ReadonlyArray<{ slug: string }>,
): Record<string, string> | undefined {
  if (fingerprints === undefined) {
    return undefined;
  }

  const allowedSlugs = new Set(communities.map((community) => community.slug));
  const entries = Object.entries(fingerprints)
    .filter(([slug]) => allowedSlugs.has(slug))
    .sort(([left], [right]) => left.localeCompare(right));

  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function prepareCommunityTopologyRefresh(
  kb: KbRuntime,
  index: KbIndex,
): {
  topologyHash: string;
  nextSummaryInputFingerprints: Record<string, string> | undefined;
  shouldPersistState: boolean;
} {
  const state = readCurateState(kb);
  const graph = buildEntityRelationshipGraph({
    entityMeta: index.entityMeta ?? {},
    relationships: index.relationships ?? [],
  });
  const topologyHash = computeCommunityTopologyFingerprint(index, graph);
  if (state.communityTopologyHash === topologyHash) {
    return {
      topologyHash,
      nextSummaryInputFingerprints: normalizedCommunitySummaryFingerprints(
        state.communitySummaryInputFingerprints,
        Object.values(index.entries).filter(isCommunityEntry),
      ),
      shouldPersistState: false,
    };
  }

  const { generated: priorGeneratedCommunities, reservedSlugs } = loadExistingCommunityState(kb);
  const communities = detectCommunities(graph, {
    priorCommunities: priorGeneratedCommunities,
    reservedSlugs,
  });
  const communityDocuments = buildCommunityDocuments(communities, {
    priorGeneratedCommunities,
    today: new Date().toISOString().slice(0, 10),
  });
  generateCommunityFiles(kb, communityDocuments, priorGeneratedCommunities);

  return {
    topologyHash,
    nextSummaryInputFingerprints: normalizedCommunitySummaryFingerprints(
      state.communitySummaryInputFingerprints,
      communityDocuments,
    ),
    shouldPersistState: true,
  };
}

function applyLaneMutation(
  state: Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>,
  lane: KbIndexMutationLane | null,
): Pick<KbIndexState, 'contentSeq' | 'metadataSeq'> {
  if (lane === null) {
    return state;
  }

  const nextSeq = Math.max(state.contentSeq, state.metadataSeq) + 1;
  return {
    contentSeq: lane === 'content' || lane === 'both' ? nextSeq : state.contentSeq,
    metadataSeq: lane === 'metadata' || lane === 'both' ? nextSeq : state.metadataSeq,
  };
}

function readMalformedRepairEntry(
  path: string,
  kind: 'note' | 'source',
  slug: string,
  detectedAt: string,
): PendingRepair | null {
  try {
    return extractMalformedEntryRepair(kind, slug, readFileSync(path, 'utf-8'), detectedAt);
  } catch {
    return null;
  }
}

function loadNotes(kb: KbRuntime, detectedAt: string): LoadedArtifacts<KbReindexNoteRecord> {
  const notesPath = kb.notesDir();
  const notes: KbReindexNoteRecord[] = [];
  const pendingRepair: PendingRepair[] = [];

  for (const entry of sortedMarkdownEntries(notesPath)) {
    try {
      const { frontmatter, title, body } = loadKbNote(join(notesPath, entry));
      const identity = deriveNoteIdentity(entry);
      notes.push({
        note: identity.note,
        path: `notes/${entry}`,
        domain: identity.domain,
        title,
        body,
        ...frontmatter,
      });
    } catch (error: unknown) {
      const repair = readMalformedRepairEntry(join(notesPath, entry), 'note', stripMdExt(entry), detectedAt);
      if (repair !== null) {
        pendingRepair.push(repair);
      }
      backendLog.warn(`Skipping malformed KB note ${entry}: ${errorMessage(error)}`);
    }
  }

  return {
    entries: notes,
    pendingRepair,
  };
}

function loadSources(kb: KbRuntime, detectedAt: string): LoadedArtifacts<KbReindexSourceRecord> {
  const sourcesPath = kb.sourcesDir();
  const sources: KbReindexSourceRecord[] = [];
  const pendingRepair: PendingRepair[] = [];

  for (const entry of sortedMarkdownEntries(sourcesPath)) {
    try {
      const raw = readFileSync(join(sourcesPath, entry), 'utf-8');
      sources.push({
        slug: assertSourceSlug(stripMdExt(entry), 'KB source name'),
        path: `sources/${entry}`,
        body: extractBody(raw),
        ...parseSourceFrontmatter(raw),
      });
    } catch (error: unknown) {
      const repair = readMalformedRepairEntry(join(sourcesPath, entry), 'source', stripMdExt(entry), detectedAt);
      if (repair !== null) {
        pendingRepair.push(repair);
      }
      backendLog.warn(`Skipping malformed KB source ${entry}: ${errorMessage(error)}`);
    }
  }

  return {
    entries: sources,
    pendingRepair,
  };
}

function loadCommunityDocument(communityPath: string): Omit<KbReindexCommunityRecord, 'path' | 'slug'> {
  const raw = readFileSync(communityPath, 'utf-8');
  const frontmatter = parseCommunityFrontmatter(raw);
  const body = extractBody(raw);
  return {
    ...frontmatter,
    title: extractTitle(raw),
    body,
    level: frontmatter.level,
    members: parseMembersFromBody(body),
    ...(frontmatter.parent === undefined ? {} : { parent: frontmatter.parent }),
    ...(frontmatter.children === undefined ? {} : { children: frontmatter.children }),
    summary: parseSummaryFromBody(body),
  };
}

export function loadCommunities(kb: KbRuntime): KbReindexCommunityRecord[] {
  const communitiesPath = kb.communitiesDir();
  const communities: KbReindexCommunityRecord[] = [];

  for (const entry of sortedMarkdownEntries(communitiesPath)) {
    try {
      communities.push({
        slug: assertCommunitySlug(stripMdExt(entry), 'KB community name'),
        path: `communities/${entry}`,
        ...loadCommunityDocument(join(communitiesPath, entry)),
      });
    } catch (error: unknown) {
      backendLog.warn(`Skipping malformed KB community ${entry}: ${errorMessage(error)}`);
    }
  }

  return communities;
}

function loadPrinciples(kb: KbRuntime): Array<[string, string]> {
  const principlesPath = kb.principlesDir();
  const principles: Array<[string, string]> = [];

  for (const entry of sortedMarkdownEntries(principlesPath)) {
    try {
      const name = stripMdExt(entry);
      const content = readFileSync(join(principlesPath, entry), 'utf-8');
      principles.push([name, extractPrincipleStatement(content)]);
    } catch (error: unknown) {
      backendLog.warn(`Skipping malformed KB principle ${entry}: ${errorMessage(error)}`);
    }
  }

  return principles;
}

function buildKbIndex(
  kb: KbRuntime,
  notes: KbReindexNoteRecord[],
  sources: KbReindexSourceRecord[],
  communities: KbReindexCommunityRecord[],
  principles: Array<[string, string]>,
): KbIndex {
  const entries: KbIndex['entries'] = {};
  const entityGraph = kb.readEntityGraph();

  for (const note of notes) {
    entries[noteEntryId(note.note)] = buildNoteIndexEntry({
      slug: note.note,
      title: note.title,
      tags: note.tags,
      principles: note.principles,
      source: note.source,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      related: note.related ?? [],
      ...(note.entrySeq === undefined ? {} : { entrySeq: note.entrySeq }),
    });
  }

  for (const source of sources) {
    entries[sourceEntryId(source.slug)] = buildSourceIndexEntry({
      slug: source.slug,
      title: source.title,
      type: source.type,
      tags: source.tags,
      ...(source.url === undefined ? {} : { url: source.url }),
      importedAt: source.importedAt,
      related: source.related ?? [],
      ...(source.entrySeq === undefined ? {} : { entrySeq: source.entrySeq }),
    });
  }

  for (const community of communities) {
    entries[communityEntryId(community.slug)] = buildCommunityIndexEntry({
      slug: community.slug,
      title: community.title,
      level: community.level,
      members: community.members,
      ...(community.parent === undefined ? {} : { parent: community.parent }),
      ...(community.children === undefined ? {} : { children: community.children }),
      ...(community.summary === undefined ? {} : { summary: community.summary }),
      createdAt: community.createdAt,
      updatedAt: community.updatedAt,
    });
  }

  return {
    entries,
    principles: Object.fromEntries(principles),
    ...(entityGraph === null
      ? {}
      : {
          entityMeta: entityGraph.entityMeta,
          relationships: entityGraph.relationships,
        }),
  };
}

function buildCounts(
  notes: KbReindexNoteRecord[],
  sources: KbReindexSourceRecord[],
  communities: KbReindexCommunityRecord[],
  principles: Array<[string, string]>,
  index: KbIndex,
): Pick<
  ReindexResult,
  'notes' | 'sources' | 'communities' | 'principles' | 'tags' | 'entities' | 'relationships' | 'entityCoverage'
> {
  const entityMeta = index.entityMeta ?? {};
  const uniqueTags = new Set([
    ...notes.flatMap((note) => note.tags),
    ...sources.flatMap((source) => source.tags),
    ...communities.flatMap((community) => community.members),
  ]);
  const entityNames = Object.keys(entityMeta);
  const coveredTags = [...uniqueTags].filter((tag) => Object.prototype.hasOwnProperty.call(entityMeta, tag)).length;
  return {
    notes: notes.length,
    sources: sources.length,
    communities: communities.length,
    principles: principles.length,
    tags: uniqueTags.size,
    entities: entityNames.length,
    relationships: index.relationships?.length ?? 0,
    entityCoverage: uniqueTags.size === 0 ? 1 : coveredTags / uniqueTags.size,
  };
}

export class TextSnapshotRebuildError extends Error {
  readonly counts: Pick<
    ReindexResult,
    'notes' | 'sources' | 'communities' | 'principles' | 'tags' | 'entities' | 'relationships' | 'entityCoverage'
  >;
  readonly pendingRepair: PendingRepair[] | null;

  constructor(
    message: string,
    counts: Pick<
      ReindexResult,
      'notes' | 'sources' | 'communities' | 'principles' | 'tags' | 'entities' | 'relationships' | 'entityCoverage'
    >,
    pendingRepair: PendingRepair[] | null,
  ) {
    super(message);
    this.name = 'TextSnapshotRebuildError';
    this.counts = counts;
    this.pendingRepair = pendingRepair;
  }
}

function persistPendingRepair(kb: KbRuntime, pendingRepair: PendingRepair[] | null): void {
  const state = readCurateState(kb);
  writeCurateState(kb, {
    ...state,
    pendingRepair,
  });
}

/**
 * @precondition Caller already holds `kb.withMutationLock()`.
 */
export async function rebuildTextArtifacts(
  kb: KbRuntime,
  startState: Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>,
): Promise<{
  notes: KbReindexNoteRecord[];
  sources: KbReindexSourceRecord[];
  communities: KbReindexCommunityRecord[];
  principles: Array<[string, string]>;
  counts: Pick<
    ReindexResult,
    'notes' | 'sources' | 'communities' | 'principles' | 'tags' | 'entities' | 'relationships' | 'entityCoverage'
  >;
  pendingRepair: PendingRepair[] | null;
}> {
  const detectedAt = new Date().toISOString();
  const { entries: notes, pendingRepair: malformedNotes } = loadNotes(kb, detectedAt);
  const { entries: sources, pendingRepair: malformedSources } = loadSources(kb, detectedAt);
  const principles = loadPrinciples(kb);
  const pendingRepair = [...malformedNotes, ...malformedSources];
  const rebuildInfo = detectTextArtifactRebuildInfo(kb);
  const topologyIndex = buildKbIndex(kb, notes, sources, [], principles);
  const topologyRefresh = prepareCommunityTopologyRefresh(kb, topologyIndex);
  const communities = loadCommunities(kb);
  const index = buildKbIndex(kb, notes, sources, communities, principles);
  const counts = buildCounts(notes, sources, communities, principles, index);
  const pendingRepairState = pendingRepair.length === 0 ? null : pendingRepair;
  const curateState = readCurateState(kb);
  const projectedCommunityState = topologyRefresh.shouldPersistState
    ? {
        ...curateState,
        communityTopologyHash: topologyRefresh.topologyHash,
        communitySummaryTopologyHash: topologyRefresh.topologyHash,
        communitySummaryInputFingerprints: topologyRefresh.nextSummaryInputFingerprints,
      }
    : curateState;
  const communityFresh = areCommunityDocumentsFreshForState(projectedCommunityState, kb, index);
  const { db, tokenizer } = await createOramaDb();

  await insertMultiple(db, [
    ...notes.map((note) => toOramaDocument(note)),
    ...sources.map((source) => toOramaDocument(source)),
    ...communities.map((community) => toOramaDocument(community, { communityFresh })),
  ]);
  kb.persistIndexToDisk(index);

  try {
    kb.persistOramaSnapshot(db);
  } catch (error: unknown) {
    const reason = `KB text index rebuild failed: ${errorMessage(error)}`;
    kb.invalidateTextSnapshot(reason);
    kb.invalidateKbCache();
    throw new TextSnapshotRebuildError(reason, counts, pendingRepairState);
  }

  const nextState = kb.recordReindexSuccess(startState, rebuildInfo.externalMutation);
  const expectedState = applyLaneMutation(startState, rebuildInfo.externalMutation);
  if (
    nextState.contentSeq !== expectedState.contentSeq ||
    nextState.metadataSeq !== expectedState.metadataSeq ||
    nextState.textStaleReason !== undefined
  ) {
    const reason = 'KB text index freshness changed during rebuild.';
    kb.invalidateTextSnapshot(reason);
    kb.invalidateKbCache();
    throw new TextSnapshotRebuildError(reason, counts, pendingRepairState);
  }

  kb.installRebuiltArtifacts(index, { db, tokenizer });

  if (topologyRefresh.shouldPersistState) {
    const currentState = readCurateState(kb);
    writeCurateState(kb, {
      ...currentState,
      communityTopologyHash: topologyRefresh.topologyHash,
      communitySummaryTopologyHash: topologyRefresh.topologyHash,
      communitySummaryInputFingerprints: topologyRefresh.nextSummaryInputFingerprints,
    });
  }

  return {
    notes,
    sources,
    communities,
    principles,
    counts,
    pendingRepair: pendingRepairState,
  };
}

/**
 * @precondition Caller already holds `kb.withMutationLock()`.
 */
export async function rebuildTextArtifactsAndPersistRepairState(
  kb: KbRuntime,
  startState: Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>,
): Promise<Awaited<ReturnType<typeof rebuildTextArtifacts>>> {
  try {
    const result = await rebuildTextArtifacts(kb, startState);
    persistPendingRepair(kb, result.pendingRepair);
    return result;
  } catch (error: unknown) {
    if (error instanceof TextSnapshotRebuildError) {
      persistPendingRepair(kb, error.pendingRepair);
    }
    throw error;
  }
}
