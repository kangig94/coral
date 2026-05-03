import { serializeCoralSetupError } from '../../runtime/errors.js';
import { KB_FTS_CAPABILITY } from '../capability/constants.js';
import { areCommunityDocumentsFresh } from '../curate/community/freshness.js';
import { denormalizeSlug, normalizeWhitespace } from '../text-normalization.js';
import type {
  FtsHit,
  FusedRetrievalHit,
  RetrievedDocument,
  RetrievalDiagnostic,
  RetrievalRole,
  RoleQueryContext,
  RoleSearchResult,
} from './contract.js';
import type { Backed, FtsRetrieval, KbRuntime } from '../contract.js';
import {
  getEntry,
  isCommunityEntry,
  isNoteEntry,
  parseKbEntryId,
  type KbEntryId,
  type KbIndex,
  type KbResult,
  type KbSearchMode,
  type KbSearchResponse,
  type KbSearchScope,
} from '../entry-types.js';

const KIND_ORDER: Record<KbResult['kind'], number> = {
  note: 0,
  community: 1,
  source: 2,
};

const BUILTIN_TEXT_ROLE_DESCRIPTOR = {
  id: 'text',
  label: 'Text (FTS)',
  tags: ['lexical'],
  phase: 'retrieval-source',
  provides: 'retrieval-source',
  supportsScopes: ['notes', 'sources', 'communities', 'all'],
  requires: [KB_FTS_CAPABILITY],
} as const satisfies RetrievalRole['descriptor'];

export type ResolvedKbSearchEntry = {
  entryId: KbEntryId;
  slug: string;
  kind: KbResult['kind'];
  title: string;
  tags: string[];
  principles: string[];
};

export type ResolvedKbSearchHit = ResolvedKbSearchEntry & {
  document: RetrievedDocument;
  score: number;
};

export type HybridKbSearchHit = FusedRetrievalHit;

export type SearchResponseWarnings = {
  warning?: string;
  warnings?: string[];
};

export function resolveEntry(entryId: string, index: KbIndex): ResolvedKbSearchEntry | null {
  const normalizedEntryId = parseKbEntryId(entryId);
  if (normalizedEntryId === null) {
    return null;
  }

  const entry = getEntry(index, normalizedEntryId);
  if (entry === undefined) {
    return null;
  }

  return {
    entryId: normalizedEntryId,
    slug: entry.slug,
    kind: entry.kind,
    title: entry.title,
    tags: isCommunityEntry(entry) ? [...entry.members] : [...entry.tags],
    principles: isNoteEntry(entry) ? [...entry.principles] : [],
  };
}

export function resolveHit(hit: FtsHit, index: KbIndex): ResolvedKbSearchHit {
  const resolvedEntry = resolveEntry(hit.fields.entryId, index);

  return {
    entryId: resolvedEntry?.entryId ?? (hit.fields.entryId as KbEntryId),
    document: hit.fields,
    score: hit.score,
    slug: resolvedEntry?.slug ?? denormalizeSlug(hit.fields.slug),
    kind: resolvedEntry?.kind ?? hit.fields.kind,
    title: resolvedEntry?.title ?? hit.fields.title,
    tags: resolvedEntry?.tags ?? [...hit.fields.tags],
    principles: resolvedEntry?.principles ?? [...hit.fields.principles],
  };
}

export function compareRetrievalRoleHits(
  left: Pick<ResolvedKbSearchEntry, 'entryId'> & { score: number },
  right: Pick<ResolvedKbSearchEntry, 'entryId'> & { score: number },
): number {
  const scoreDelta = right.score - left.score;
  if (Math.abs(scoreDelta) > 1e-12) {
    return scoreDelta;
  }

  return left.entryId.localeCompare(right.entryId);
}

export function rankRetrievalRoleHits<T extends { entryId: KbEntryId; score: number }>(
  hits: readonly T[],
): Array<T & { rank: number }> {
  return [...hits].sort(compareRetrievalRoleHits).map((hit, index) => ({
    ...hit,
    rank: index + 1,
  }));
}

export function filterHitsByScope<T extends { kind: KbResult['kind'] }>(hits: T[], scope: KbSearchScope): T[] {
  if (scope === 'all') {
    // Communities are meta-documents: include them only when explicitly requested.
    return hits.filter((hit) => hit.kind !== 'community');
  }

  if (scope === 'notes') {
    return hits.filter((hit) => hit.kind === 'note');
  }

  if (scope === 'sources') {
    return hits.filter((hit) => hit.kind === 'source');
  }

  return hits.filter((hit) => hit.kind === 'community');
}

function isSearchableHit(hit: ResolvedKbSearchHit, communitiesFresh: boolean): boolean {
  if (hit.kind !== 'community') {
    return true;
  }

  if (hit.document.freshness === 'stale') {
    return false;
  }

  if (hit.document.freshness === 'fresh') {
    return true;
  }

  return communitiesFresh;
}

export function filterSearchableHits(hits: ResolvedKbSearchHit[], communitiesFresh: boolean): ResolvedKbSearchHit[] {
  return hits.filter((hit) => isSearchableHit(hit, communitiesFresh));
}

export function rerankHits<T extends { score: number; kind: KbResult['kind']; slug: string }>(hits: T[]): T[] {
  return [...hits].sort((left, right) => {
    const scoreDelta = right.score - left.score;
    if (scoreDelta !== 0) {
      return scoreDelta;
    }

    if (left.kind !== right.kind) {
      return KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
    }

    return left.slug.localeCompare(right.slug);
  });
}

function maxPossibleOmittedScore(hits: readonly FtsHit[]): number {
  const boundaryHit = hits.at(-1);
  if (boundaryHit === undefined) {
    return Number.NEGATIVE_INFINITY;
  }

  return boundaryHit.score;
}

export function shouldContinueWidening(
  hits: readonly FtsHit[],
  resolvedHits: ResolvedKbSearchHit[],
  communitiesFresh: boolean,
  scope: KbSearchScope,
  topK: number,
  exhausted: boolean,
): boolean {
  const searchableHits = filterSearchableHits(resolvedHits, communitiesFresh);
  if (scope !== 'all') {
    return !exhausted && filterHitsByScope(searchableHits, scope).length < topK;
  }

  const rerankedHits = rerankHits(searchableHits);
  if (rerankedHits.length < topK) {
    return !exhausted;
  }

  return !exhausted && rerankedHits[topK - 1].score <= maxPossibleOmittedScore(hits);
}

function textBindingMissingDiagnostic(): RetrievalDiagnostic {
  return {
    roleId: 'text',
    code: 'binding_missing',
    recoverable: true,
    publicText: 'kb_search_degraded_until_coordinator_rebuild',
  };
}

function isFtsBindingMissing(error: unknown): boolean {
  const setupError = serializeCoralSetupError(error);
  return setupError?.code === 'binding_empty' && setupError.context?.binding === KB_FTS_CAPABILITY;
}

function isFtsUnavailable(fts: FtsRetrieval): boolean {
  const warnings = fts.warnings();
  return warnings.includes('fts_index_uninitialized') || warnings.includes('fts_index_stale');
}

function degradedTextRoleSearchResult(): RoleSearchResult {
  return {
    hits: [],
    diagnostic: textBindingMissingDiagnostic(),
  };
}

function textRoleSearchResult(hits: readonly ResolvedKbSearchHit[]): RoleSearchResult {
  return {
    hits: rankRetrievalRoleHits(hits).map((hit) => ({
      entryId: hit.entryId,
      slug: hit.slug,
      kind: hit.kind,
      title: hit.title,
      tags: [...hit.tags],
      principles: [...hit.principles],
      rank: hit.rank,
      score: hit.score,
      document: hit.document,
    })),
  };
}

async function searchTextRoleHits(rt: KbRuntime, ctx: RoleQueryContext): Promise<RoleSearchResult> {
  let fts: FtsRetrieval;
  try {
    fts = rt.capabilityRegistry.runtimeView().read<Backed<FtsRetrieval>>(KB_FTS_CAPABILITY).read();
  } catch (error) {
    if (isFtsBindingMissing(error)) {
      return degradedTextRoleSearchResult();
    }
    throw error;
  }

  if (isFtsUnavailable(fts)) {
    return degradedTextRoleSearchResult();
  }

  const normalizedQuery = normalizeWhitespace(ctx.rawQuery);
  const queryTokens = fts.tokenize(normalizedQuery);
  if (queryTokens.length === 0) {
    return { hits: [] };
  }

  const index = ctx.index();
  const communitiesFresh = areCommunityDocumentsFresh(rt, index);
  const resolvedHits: ResolvedKbSearchHit[] = [];
  let limit = ctx.topK;
  let result = await fts.search(normalizedQuery, limit, ctx.scope);
  resolvedHits.push(...result.hits.map((hit) => resolveHit(hit, index)));

  while (shouldContinueWidening(result.hits, resolvedHits, communitiesFresh, ctx.scope, ctx.topK, result.exhausted)) {
    const prevCount = result.hits.length;
    limit = Math.max(limit + 1, limit * 2);
    result = await fts.search(normalizedQuery, limit, ctx.scope);
    for (let i = prevCount; i < result.hits.length; i += 1) {
      resolvedHits.push(resolveHit(result.hits[i], index));
    }
  }

  const searchableHits = filterSearchableHits(resolvedHits, communitiesFresh);
  const selectedHits = ctx.scope === 'all' ? rerankHits(searchableHits) : filterHitsByScope(searchableHits, ctx.scope);
  return textRoleSearchResult(selectedHits);
}

export function createBuiltinTextRole(rt: KbRuntime): RetrievalRole {
  return {
    id: BUILTIN_TEXT_ROLE_DESCRIPTOR.id,
    descriptor: BUILTIN_TEXT_ROLE_DESCRIPTOR,
    search(ctx) {
      return searchTextRoleHits(rt, ctx);
    },
  };
}

export function isVectorScope(kind: KbResult['kind'], scope: KbSearchScope): boolean {
  if (kind === 'community') {
    return false;
  }

  if (scope === 'all') {
    return true;
  }

  if (scope === 'notes') {
    return kind === 'note';
  }

  if (scope === 'sources') {
    return kind === 'source';
  }

  return false;
}

export function emptySearchResponse(mode?: KbSearchMode | 'auto'): KbSearchResponse {
  if (mode === 'vector') {
    return {
      results: [],
      mode: 'vector',
      retrievalDiagnostics: [],
    };
  }
  if (mode === 'hybrid') {
    return {
      results: [],
      mode: 'hybrid',
      retrievalDiagnostics: [],
    };
  }
  return {
    results: [],
    mode: 'text',
    retrievalDiagnostics: [],
  };
}
