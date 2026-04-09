import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isNoEntryError } from '../../shared/utils.js';
import type { KbRuntime } from '../contracts.js';
import {
  extractTitle,
  parseFrontmatter,
  parseSourceFrontmatter,
  replaceFrontmatter,
  replaceSourceFrontmatter,
} from '../frontmatter.js';
import {
  buildNoteIndexEntry,
  buildSourceIndexEntry,
  cloneKbIndex,
  recordMetadataMutation,
  writeFileAtomic,
} from '../mutation-helpers.js';
import { runEntrySeqUpgradeGuard } from '../entry-seq-guard.js';
import { compareLocale } from '../validation.js';
import {
  isNoteEntry,
  isSourceEntry,
  noteEntryId,
  sourceEntryId,
  type EntityGraph,
  type EntityMeta,
  type EntityRelationship,
} from '../types.js';
import {
  compareCursor,
  getCurateRepairFrontier,
  normalizeCurateStateRepairFrontier,
  readCurateState,
  sameStringList,
  writeCurateState,
  type CurateCursor,
  type CurateRepairFrontier,
  type CurateState,
} from './state.js';
import {
  consolidateEntityGraph,
  resolveCanonicalEntityId,
  type ConsolidationResult,
  type EntityConsolidationDelta,
  type EntityReplacementMap,
} from './entity-consolidation.js';
import { CURATE_STALE_REASON } from './operations.js';
import type { MetadataTarget, NoteMetadataTarget } from './types.js';

export type MetadataCommitPlan = {
  graphDelta?: EntityConsolidationDelta;
};

type LiveMetadataDecision = {
  shouldWrite: boolean;
  nextTags: string[];
  nextPrinciples: string[];
};

function fingerprintEntryContent(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function uniqueTrimmedList(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function cloneEntityMetaMap(entityMeta: Record<string, EntityMeta>): Record<string, EntityMeta> {
  return Object.fromEntries(
    Object.entries(entityMeta).map(([entityName, meta]) => [
      entityName,
      {
        type: meta.type,
        description: meta.description,
        ...(meta.aliases === undefined ? {} : { aliases: [...meta.aliases] }),
      },
    ]),
  );
}

function cloneEntityRelationships(relationships: EntityRelationship[]): EntityRelationship[] {
  return relationships.map((relationship) => ({
    source: relationship.source,
    target: relationship.target,
    type: relationship.type,
    description: relationship.description,
    evidence: [...relationship.evidence],
  }));
}

function snapshotEntityGraph(currentIndex: { entityMeta?: Record<string, EntityMeta>; relationships?: EntityRelationship[] }): EntityGraph {
  return {
    entityMeta: cloneEntityMetaMap(currentIndex.entityMeta ?? {}),
    relationships: cloneEntityRelationships(currentIndex.relationships ?? []),
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

  return candidates.filter((candidate) => isCursorBeforeRepairFrontier(candidate.cursor, frontier));
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

function compareOptionalCursor(left: CurateCursor | null, right: CurateCursor): number {
  if (left === null) {
    return -1;
  }

  return compareCursor(left, right);
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
  const nextTags = desiredTags ?? uniqueTrimmedList([...liveTags, ...addTags]).filter((tag) => !removeTagSet.has(tag));

  const removePrincipleSet = new Set(removePrinciples);
  const nextPrinciples = uniqueTrimmedList([...livePrinciples, ...addPrinciples]).filter(
    (principle) => !removePrincipleSet.has(principle),
  );

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

  return desiredTags ?? uniqueTrimmedList([...liveTags, ...addTags]).filter((tag) => !removeTagSet.has(tag));
}

function buildLiveRelatedMetadata(target: MetadataTarget, liveRelated: string[]): string[] {
  const addRelated = uniqueTrimmedList(target.addRelated ?? []);
  if (addRelated.length === 0) {
    return [...liveRelated];
  }

  const existing = new Set(liveRelated);
  const additions = addRelated.filter((relatedEntryId) => !existing.has(relatedEntryId));
  if (additions.length === 0) {
    return [...liveRelated];
  }

  return [...liveRelated, ...additions];
}

function applyEntityReplacementMap(tags: string[] | undefined, replacementMap: EntityReplacementMap): string[] | undefined {
  if (tags === undefined) {
    return undefined;
  }

  return uniqueTrimmedList(tags.map((tag) => resolveCanonicalEntityId(tag, replacementMap)));
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
  targets: MetadataTarget[],
  state: CurateState,
  plan: MetadataCommitPlan = {},
): Promise<CurateState> {
  const normalizedState = normalizeCurateStateRepairFrontier(state);
  const repairFrontier = getCurateRepairFrontier(normalizedState.pendingRepair);
  const currentIndex = kb.readIndexOrEmpty();
  const nextIndex = cloneKbIndex(currentIndex);
  const currentGraph = snapshotEntityGraph(currentIndex);
  const consolidationResult: ConsolidationResult = consolidateEntityGraph(currentGraph, plan.graphDelta);
  const desiredGraph = consolidationResult.canonicalGraph;
  const graphChanged = !entityGraphsEqual(currentGraph, desiredGraph);
  const sortedTargets = [...targets]
    .map((target) => rewriteMetadataTargetEntities(target, consolidationResult.replacementMap))
    .sort(compareMetadataTarget);

  nextIndex.entityMeta = cloneEntityMetaMap(desiredGraph.entityMeta);
  nextIndex.relationships = cloneEntityRelationships(desiredGraph.relationships);
  let processedThrough = normalizedState.processedThrough;
  let cursorCanAdvance = true;
  let wroteMarkdown = false;
  let failure: unknown = null;

  if (graphChanged) {
    try {
      writeFileAtomic(kb.entityGraphPath(), `${JSON.stringify(desiredGraph, null, 2)}\n`);
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
        raw = readFileSync(notePath, 'utf-8');
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

      writeFileAtomic(notePath, replaceFrontmatter(raw, nextFrontmatter));
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
      raw = readFileSync(sourcePath, 'utf-8');
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

    writeFileAtomic(sourcePath, replaceSourceFrontmatter(raw, nextFrontmatter));
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

  const nextState = normalizeCurateStateRepairFrontier({
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

  writeCurateState(kb, nextState);
  return nextState;
}

export async function commitMetadataTargets(
  kb: KbRuntime,
  targets: MetadataTarget[],
  plan: MetadataCommitPlan = {},
): Promise<void> {
  await kb.withMutationLock(async () => {
    runEntrySeqUpgradeGuard(kb);
    const state = readCurateState(kb);
    await commitMetadataTargetsLocked(kb, targets, state, plan);
  });
}
