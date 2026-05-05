import { isNoEntryError } from '../../infra/fs-errors.js';
import type { KbMutationEffects, KbRuntime } from '../contract.js';
import { captureNoteManifestDeltas, captureSourceManifestDeltas } from '../corpus/manifest-authority.js';
import {
  extractTitle,
  parseFrontmatter,
  parseSourceFrontmatter,
  replaceFrontmatter,
  replaceSourceFrontmatter,
} from '../corpus/frontmatter.js';
import { writeFileAtomic } from '../corpus/file-atomic.js';
import { recordMetadataMutation } from '../corpus/index-mutations.js';
import {
  buildNoteIndexEntry,
  buildSourceIndexEntry,
  cloneEntityMetaRecord,
  cloneEntityRelationship,
  cloneKbIndex,
} from '../corpus/index-records.js';
import {
  isNoteEntry,
  isSourceEntry,
  noteEntryId,
  sourceEntryId,
  type EntityGraph,
  type EntityMeta,
  type EntityRelationship,
} from '../entry-types.js';
import { fingerprintEntryContent, uniqueTrimmedList } from './content-normalize.js';
import {
  compareCursor,
  compareOptionalCursor,
  getCurateRepairFrontier,
  normalizeCurateStateRepairFrontier,
  readCurateState,
  sameStringList,
  writeCurateState,
  type CurateCursor,
  type CurateRepairFrontier,
  type CurateState,
} from './state/index.js';
import {
  consolidateEntityGraph,
  resolveCanonicalEntityId,
  type ConsolidationResult,
  type EntityConsolidationDelta,
  type EntityReplacementMap,
} from './entity-consolidation.js';
import { CURATE_STALE_REASON } from './operations.js';
import type { MetadataTarget, NoteMetadataTarget } from './pipeline-types.js';
import { curateDb } from './db-access.js';

export type MetadataCommitPlan = {
  graphDelta?: EntityConsolidationDelta;
};

type LiveMetadataDecision = {
  shouldWrite: boolean;
  nextTags: string[];
  nextPrinciples: string[];
};

function snapshotEntityGraph(currentIndex: {
  entityMeta: Record<string, EntityMeta>;
  relationships: EntityRelationship[];
}): EntityGraph {
  const relationships: EntityRelationship[] = [];
  for (const relationship of currentIndex.relationships) {
    relationships.push(cloneEntityRelationship(relationship));
  }

  return {
    entityMeta: cloneEntityMetaRecord(currentIndex.entityMeta),
    relationships,
  };
}

function entityGraphsEqual(left: EntityGraph, right: EntityGraph): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isCursorBeforeRepairFrontier(cursor: CurateCursor, frontier: CurateRepairFrontier): boolean {
  if (frontier.kind === 'none') {
    return true;
  }
  if (frontier.kind === 'unknown') {
    return false;
  }

  return compareCursor(cursor, frontier.cursor) < 0;
}

export function filterCandidatesBeforeRepairFrontier<T extends { cursor: CurateCursor }>(
  candidates: T[],
  frontier: CurateRepairFrontier,
): T[] {
  if (frontier.kind === 'none') {
    return candidates;
  }

  const filtered: T[] = [];
  for (const candidate of candidates) {
    if (isCursorBeforeRepairFrontier(candidate.cursor, frontier)) {
      filtered.push(candidate);
    }
  }
  return filtered;
}

export function cursorFromTarget(target: MetadataTarget): CurateCursor {
  return {
    entryId: target.entryId,
    entrySeq: target.entrySeq,
  };
}

export function compareMetadataTarget(left: MetadataTarget, right: MetadataTarget): number {
  return compareCursor(cursorFromTarget(left), cursorFromTarget(right));
}

function advanceProcessedThrough(
  processedThrough: CurateCursor | null,
  cursorCanAdvance: boolean,
  cursor: CurateCursor,
): CurateCursor | null {
  if (!cursorCanAdvance || compareOptionalCursor(processedThrough, cursor) >= 0) {
    return processedThrough;
  }

  return cursor;
}

function buildLiveNoteMetadataDecision(
  target: NoteMetadataTarget,
  liveTags: string[],
  livePrinciples: string[],
): LiveMetadataDecision {
  const addTags = uniqueTrimmedList(target.addTags ?? []);
  const addPrinciples = uniqueTrimmedList(target.addPrinciples ?? []);
  const removePrinciples = uniqueTrimmedList(target.removePrinciples ?? []);
  const removeTags = uniqueTrimmedList(target.removeTags ?? []);
  const desiredTags = target.desiredTags === undefined ? undefined : uniqueTrimmedList(target.desiredTags);

  const removeTagSet = new Set(removeTags);
  let nextTags = desiredTags;
  if (nextTags === undefined) {
    const keptTags: string[] = [];
    for (const tag of uniqueTrimmedList([...liveTags, ...addTags])) {
      if (!removeTagSet.has(tag)) {
        keptTags.push(tag);
      }
    }
    nextTags = keptTags;
  }

  const removePrincipleSet = new Set(removePrinciples);
  const nextPrinciples: string[] = [];
  for (const principle of uniqueTrimmedList([...livePrinciples, ...addPrinciples])) {
    if (!removePrincipleSet.has(principle)) {
      nextPrinciples.push(principle);
    }
  }

  return {
    shouldWrite: !sameStringList(nextTags, liveTags) || !sameStringList(nextPrinciples, livePrinciples),
    nextTags,
    nextPrinciples,
  };
}

function buildLiveSourceMetadataDecision(
  target: Extract<MetadataTarget, { kind: 'source' }>,
  liveTags: string[],
): string[] {
  const addTags = uniqueTrimmedList(target.addTags ?? []);
  const removeTags = uniqueTrimmedList(target.removeTags ?? []);
  const desiredTags = target.desiredTags === undefined ? undefined : uniqueTrimmedList(target.desiredTags);
  const removeTagSet = new Set(removeTags);

  if (desiredTags !== undefined) {
    return desiredTags;
  }

  const nextTags: string[] = [];
  for (const tag of uniqueTrimmedList([...liveTags, ...addTags])) {
    if (!removeTagSet.has(tag)) {
      nextTags.push(tag);
    }
  }
  return nextTags;
}

function buildLiveRelatedMetadata(target: MetadataTarget, liveRelated: string[]): string[] {
  const addRelated = uniqueTrimmedList(target.addRelated ?? []);
  if (addRelated.length === 0) {
    return [...liveRelated];
  }

  const existing = new Set(liveRelated);
  const additions: string[] = [];
  for (const relatedEntryId of addRelated) {
    if (!existing.has(relatedEntryId)) {
      additions.push(relatedEntryId);
    }
  }
  if (additions.length === 0) {
    return [...liveRelated];
  }

  return [...liveRelated, ...additions];
}

function applyEntityReplacementMap(
  tags: string[] | undefined,
  replacementMap: EntityReplacementMap,
): string[] | undefined {
  if (tags === undefined) {
    return undefined;
  }

  const resolvedTags: string[] = [];
  for (const tag of tags) {
    resolvedTags.push(resolveCanonicalEntityId(tag, replacementMap));
  }
  return uniqueTrimmedList(resolvedTags);
}

function rewriteMetadataTargetEntities(target: MetadataTarget, replacementMap: EntityReplacementMap): MetadataTarget {
  return {
    ...target,
    ...(target.addTags === undefined ? {} : { addTags: applyEntityReplacementMap(target.addTags, replacementMap) }),
    ...(target.desiredTags === undefined
      ? {}
      : { desiredTags: applyEntityReplacementMap(target.desiredTags, replacementMap) }),
    ...(target.removeTags === undefined ? {} : { removeTags: uniqueTrimmedList(target.removeTags) }),
  };
}

export async function commitMetadataTargetsLocked(
  kb: KbRuntime,
  mutation: KbMutationEffects,
  targets: MetadataTarget[],
  state: CurateState,
  plan: MetadataCommitPlan = {},
): Promise<CurateState> {
  const normalizedState = normalizeCurateStateRepairFrontier(curateDb(kb), state);
  const repairFrontier = getCurateRepairFrontier(curateDb(kb));
  const currentIndex = kb.readIndexOrEmpty();
  const nextIndex = cloneKbIndex(currentIndex);
  const currentGraph = snapshotEntityGraph(currentIndex);
  const consolidationResult: ConsolidationResult = consolidateEntityGraph(currentGraph, plan.graphDelta);
  const desiredGraph = consolidationResult.canonicalGraph;
  const graphChanged = !entityGraphsEqual(currentGraph, desiredGraph);
  const sortedTargets: MetadataTarget[] = [];
  for (const target of targets) {
    sortedTargets.push(rewriteMetadataTargetEntities(target, consolidationResult.replacementMap));
  }
  sortedTargets.sort(compareMetadataTarget);

  nextIndex.entityMeta = cloneEntityMetaRecord(desiredGraph.entityMeta);
  nextIndex.relationships = [];
  for (const relationship of desiredGraph.relationships) {
    nextIndex.relationships.push(cloneEntityRelationship(relationship));
  }
  let processedThrough = normalizedState.processedThrough;
  let cursorCanAdvance = true;
  let wroteMarkdown = false;
  let failure: unknown = null;

  if (graphChanged) {
    try {
      mutation.writeEntityGraph(desiredGraph);
      const graphSyncedIndex = kb.readIndex();
      if (graphSyncedIndex?.structuralKey !== undefined) {
        nextIndex.structuralKey = { ...graphSyncedIndex.structuralKey };
      } else {
        delete nextIndex.structuralKey;
      }
    } catch (error: unknown) {
      failure ??= error;
    }
  }
  if (failure !== null) {
    if (failure instanceof Error) {
      throw failure;
    }
    throw new Error(typeof failure === 'string' ? failure : 'Unknown error');
  }

  for (const target of sortedTargets) {
    const cursor = cursorFromTarget(target);
    if (!isCursorBeforeRepairFrontier(cursor, repairFrontier)) {
      cursorCanAdvance = false;
      continue;
    }

    if (target.kind === 'note') {
      const notePath = kb.notePath(target.slug);
      let raw: string;

      try {
        raw = kb.storagePort.readFileSync(notePath, 'utf-8');
      } catch (error: unknown) {
        if (isNoEntryError(error)) {
          processedThrough = advanceProcessedThrough(processedThrough, cursorCanAdvance, cursor);
          continue;
        }
        throw error;
      }

      const liveFrontmatter = parseFrontmatter(raw);
      if (liveFrontmatter.updatedAt !== target.claimTimeUpdatedAt) {
        cursorCanAdvance = false;
        continue;
      }

      const metadataDecision = buildLiveNoteMetadataDecision(target, liveFrontmatter.tags, liveFrontmatter.principles);
      const nextRelated = buildLiveRelatedMetadata(target, liveFrontmatter.related ?? []);
      if (!metadataDecision.shouldWrite && sameStringList(nextRelated, liveFrontmatter.related ?? [])) {
        processedThrough = advanceProcessedThrough(processedThrough, cursorCanAdvance, cursor);
        continue;
      }

      const nextFrontmatter = {
        tags: metadataDecision.nextTags,
        principles: metadataDecision.nextPrinciples,
        source: liveFrontmatter.source,
        createdAt: liveFrontmatter.createdAt,
        updatedAt: liveFrontmatter.updatedAt,
        related: nextRelated,
        entrySeq: liveFrontmatter.entrySeq ?? target.entrySeq,
      };
      const nextRaw = replaceFrontmatter(raw, nextFrontmatter);

      writeFileAtomic(kb, notePath, nextRaw);
      mutation.queueManifestAuthorityDelta(captureNoteManifestDeltas(target.slug, nextRaw));
      wroteMarkdown = true;

      const existingIndexEntry = nextIndex.entries[noteEntryId(target.slug)];
      const existingIndexNote =
        existingIndexEntry !== undefined && isNoteEntry(existingIndexEntry) ? existingIndexEntry : undefined;
      nextIndex.entries[noteEntryId(target.slug)] = buildNoteIndexEntry({
        slug: target.slug,
        title: existingIndexNote?.title ?? extractTitle(raw),
        tags: metadataDecision.nextTags,
        principles: metadataDecision.nextPrinciples,
        source: liveFrontmatter.source,
        createdAt: liveFrontmatter.createdAt,
        updatedAt: liveFrontmatter.updatedAt,
        related: nextRelated,
        entrySeq: nextFrontmatter.entrySeq,
      });

      processedThrough = advanceProcessedThrough(processedThrough, cursorCanAdvance, cursor);
      continue;
    }

    const sourcePath = kb.sourcePath(target.slug);
    let raw: string;

    try {
      raw = kb.storagePort.readFileSync(sourcePath, 'utf-8');
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        processedThrough = advanceProcessedThrough(processedThrough, cursorCanAdvance, cursor);
        continue;
      }
      throw error;
    }

    if (fingerprintEntryContent(raw) !== target.claimTimeFingerprint) {
      cursorCanAdvance = false;
      continue;
    }

    const liveFrontmatter = parseSourceFrontmatter(raw);
    const nextTags = buildLiveSourceMetadataDecision(target, liveFrontmatter.tags);
    const nextRelated = buildLiveRelatedMetadata(target, liveFrontmatter.related ?? []);
    if (sameStringList(nextTags, liveFrontmatter.tags) && sameStringList(nextRelated, liveFrontmatter.related ?? [])) {
      processedThrough = advanceProcessedThrough(processedThrough, cursorCanAdvance, cursor);
      continue;
    }

    const nextFrontmatter = {
      title: liveFrontmatter.title,
      type: liveFrontmatter.type,
      tags: nextTags,
      ...(liveFrontmatter.url === undefined ? {} : { url: liveFrontmatter.url }),
      importedAt: liveFrontmatter.importedAt,
      related: nextRelated,
      entrySeq: liveFrontmatter.entrySeq ?? target.entrySeq,
    };
    const nextRaw = replaceSourceFrontmatter(raw, nextFrontmatter);

    writeFileAtomic(kb, sourcePath, nextRaw);
    mutation.queueManifestAuthorityDelta(captureSourceManifestDeltas(target.slug, nextRaw));
    wroteMarkdown = true;

    const existingIndexEntry = nextIndex.entries[sourceEntryId(target.slug)];
    const existingIndexSource =
      existingIndexEntry !== undefined && isSourceEntry(existingIndexEntry) ? existingIndexEntry : undefined;
    nextIndex.entries[sourceEntryId(target.slug)] = buildSourceIndexEntry({
      slug: target.slug,
      title: existingIndexSource?.title ?? liveFrontmatter.title,
      type: liveFrontmatter.type,
      tags: nextTags,
      ...(liveFrontmatter.url === undefined ? {} : { url: liveFrontmatter.url }),
      importedAt: liveFrontmatter.importedAt,
      related: nextRelated,
      entrySeq: nextFrontmatter.entrySeq,
    });

    processedThrough = advanceProcessedThrough(processedThrough, cursorCanAdvance, cursor);
  }

  const nextState = normalizeCurateStateRepairFrontier(curateDb(kb), {
    ...normalizedState,
    processedThrough,
    activeClaim: null,
  });

  if (wroteMarkdown || graphChanged) {
    recordMetadataMutation(kb, CURATE_STALE_REASON);
    try {
      kb.writeIndex(nextIndex);
    } catch (error: unknown) {
      failure ??= error;
    }
  }

  if (failure !== null) {
    if (failure instanceof Error) {
      throw failure;
    }
    throw new Error(typeof failure === 'string' ? failure : 'Unknown error');
  }

  writeCurateState(curateDb(kb), nextState);
  return nextState;
}

export async function commitMetadataTargets(
  kb: KbRuntime,
  targets: MetadataTarget[],
  plan: MetadataCommitPlan = {},
): Promise<void> {
  await kb.withMutationLock(async (mutation) => {
    const state = readCurateState(curateDb(kb));
    await commitMetadataTargetsLocked(kb, mutation, targets, state, plan);
  });
}
