import { search as oramaSearch } from '@orama/orama';

import type { KbOramaDocument } from './document-builder.js';
import type { KbOramaDb } from './schema.js';
import type { RetrievedDocument, RetrievalScope } from '../../kb/search/contract.js';
import {
  ORAMA_FIELD_EXACT_BOOST,
  ORAMA_FIELD_PHRASE_BOOST,
  ORAMA_FIELD_PRIORITY,
  ORAMA_SEARCH_CHANNEL_BOOST,
  ORAMA_SEARCH_CHANNEL_PROPERTIES,
  ORAMA_SEARCH_CHANNEL_WEIGHT,
  ORAMA_SEARCH_FIELDS,
  ORAMA_SEARCH_FUZZY_MULTIPLIER,
  ORAMA_SEARCH_RRF_K,
  normalizedCompactIdentityText,
  normalizedIdentityText,
  type OramaSearchChannel,
  type OramaSearchField,
  type OramaSearchQueryAnalysis,
} from './search-channels.js';

const FUZZY_BODY_TOKEN_SCAN_LIMIT = 512;
export const ORAMA_FUZZY_DOCUMENT_SCAN_LIMIT = 2_000;

type OramaSearchRun = {
  readonly channel: OramaSearchChannel;
  readonly terms: readonly string[];
};

type OramaCandidateCollection = {
  candidates: Map<string, OramaCandidateAccumulator>;
  exhausted: boolean;
};

type OramaCandidateAccumulator = {
  readonly document: KbOramaDocument;
  readonly channelHits: Set<OramaSearchChannel>;
  score: number;
  bestRawScore: number;
};

type OramaRankedCandidate = {
  readonly document: KbOramaDocument;
  readonly score: number;
};

export type OramaFuzzyDocumentScan = {
  readonly documents: readonly KbOramaDocument[];
  readonly truncated: boolean;
};

type OramaDocumentStoreDb = KbOramaDb & {
  readonly data: {
    readonly docs: unknown;
  };
  readonly documentsStore: {
    readonly getAll: (store: unknown) => Record<string, unknown>;
  };
};

function scopeAllowsKind(scope: RetrievalScope | undefined, kind: KbOramaDocument['kind']): boolean {
  if (scope === undefined || scope === 'all') {
    return true;
  }
  if (scope === 'notes') {
    return kind === 'note';
  }
  if (scope === 'sources') {
    return kind === 'source';
  }
  if (scope === 'wiki') {
    return kind === 'wiki';
  }
  return kind === 'community';
}

function compareScoreAndEntryId(
  left: { score: number; entryId: string },
  right: { score: number; entryId: string },
): number {
  const scoreDelta = right.score - left.score;
  if (Math.abs(scoreDelta) > 1e-12) {
    return scoreDelta;
  }
  return left.entryId.localeCompare(right.entryId);
}

function uniqueSearchTerms(terms: Iterable<string>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const term of terms) {
    if (!term || seen.has(term)) {
      continue;
    }
    seen.add(term);
    unique.push(term);
  }
  return unique;
}

function buildPrimarySearchRuns(analysis: OramaSearchQueryAnalysis): OramaSearchRun[] {
  const runs: OramaSearchRun[] = [];
  if (analysis.morph.length > 0) {
    runs.push({ channel: 'morph', terms: analysis.morph });
  }
  if (analysis.surface.length > 0) {
    runs.push({ channel: 'surface', terms: analysis.surface });
  }
  return runs;
}

function buildNgramSearchRuns(analysis: OramaSearchQueryAnalysis): OramaSearchRun[] {
  const runs: OramaSearchRun[] = [];
  if (analysis.ngram.length > 0) {
    runs.push({ channel: 'ngram', terms: analysis.ngram });
  }
  return runs;
}

function fieldSurfaceProperty(field: OramaSearchField): keyof KbOramaDocument {
  if (field === 'slug') return 'slugSurface';
  if (field === 'title') return 'titleSurface';
  if (field === 'tags') return 'tagsSurface';
  if (field === 'principles') return 'principlesSurface';
  return 'bodySurface';
}

function splitFieldTokens(value: string, limit?: number): string[] {
  if (limit === undefined) {
    return value.split(/\s+/u).filter(Boolean);
  }

  const tokens: string[] = [];
  for (const match of value.matchAll(/\S+/gu)) {
    tokens.push(match[0]);
    if (tokens.length >= limit) {
      break;
    }
  }
  return tokens;
}

function fieldTokens(document: KbOramaDocument, field: OramaSearchField, limit?: number): string[] {
  const value = document[fieldSurfaceProperty(field)];
  return typeof value === 'string' ? splitFieldTokens(value, limit) : [];
}

function fieldTokenSet(document: KbOramaDocument, field: OramaSearchField): Set<string> {
  return new Set(fieldTokens(document, field));
}

function fieldQueryCoverage(document: KbOramaDocument, field: OramaSearchField, terms: readonly string[]): number {
  const tokens = fieldTokenSet(document, field);
  let matched = 0;
  for (const term of terms) {
    if (tokens.has(term)) {
      matched += 1;
    }
  }
  return matched;
}

function fieldProximityScore(document: KbOramaDocument, field: OramaSearchField, terms: readonly string[]): number {
  const tokens = fieldTokens(document, field);
  const wanted = new Set(terms.filter((term) => term.length > 0));
  if (tokens.length === 0 || wanted.size === 0) {
    return 0;
  }

  const counts = new Map<string, number>();
  let covered = 0;
  let left = 0;
  let bestSpan = Number.POSITIVE_INFINITY;

  for (let right = 0; right < tokens.length; right += 1) {
    const rightToken = tokens[right];
    if (rightToken !== undefined && wanted.has(rightToken)) {
      const nextCount = (counts.get(rightToken) ?? 0) + 1;
      counts.set(rightToken, nextCount);
      if (nextCount === 1) {
        covered += 1;
      }
    }

    while (covered === wanted.size && left <= right) {
      bestSpan = Math.min(bestSpan, right - left + 1);
      const leftToken = tokens[left];
      if (leftToken !== undefined && wanted.has(leftToken)) {
        const nextCount = (counts.get(leftToken) ?? 0) - 1;
        if (nextCount <= 0) {
          counts.delete(leftToken);
          covered -= 1;
        } else {
          counts.set(leftToken, nextCount);
        }
      }
      left += 1;
    }
  }

  if (!Number.isFinite(bestSpan)) {
    return 0;
  }
  return wanted.size / bestSpan;
}

function documentTerms(document: KbOramaDocument, terms: readonly string[]): Set<string> {
  const matched = new Set<string>();
  for (const field of ORAMA_SEARCH_FIELDS) {
    const tokens = fieldTokenSet(document, field);
    for (const term of terms) {
      if (tokens.has(term)) {
        matched.add(term);
      }
    }
  }
  return matched;
}

function fieldIdentityScore(document: KbOramaDocument, field: OramaSearchField, phrases: readonly string[]): number {
  const identity = normalizedIdentityText(document[field]);
  const compactIdentity = normalizedCompactIdentityText(document[field]);
  let exactScore = 0;
  let phraseScore = 0;

  for (const phrase of phrases) {
    const compactPhrase = phrase.replace(/\s+/gu, '');
    if (!phrase || !compactPhrase) {
      continue;
    }
    if (identity === phrase || compactIdentity === compactPhrase) {
      exactScore = Math.max(exactScore, ORAMA_FIELD_EXACT_BOOST[field]);
    } else if (identity.includes(phrase) || compactIdentity.includes(compactPhrase)) {
      phraseScore = Math.max(phraseScore, ORAMA_FIELD_PHRASE_BOOST[field]);
    }
  }

  return exactScore + phraseScore;
}

function rankOramaCandidates(
  candidates: Iterable<OramaCandidateAccumulator>,
  analysis: OramaSearchQueryAnalysis,
): OramaRankedCandidate[] {
  const queryTerms = uniqueSearchTerms([...analysis.surface, ...analysis.morph]);
  const termDocumentFrequency = new Map<string, number>();
  const candidateTerms = new Map<string, Set<string>>();
  const candidateList = [...candidates];

  for (const candidate of candidateList) {
    const terms = documentTerms(candidate.document, queryTerms);
    candidateTerms.set(candidate.document.entryId, terms);
    for (const term of terms) {
      termDocumentFrequency.set(term, (termDocumentFrequency.get(term) ?? 0) + 1);
    }
  }

  const ranked: OramaRankedCandidate[] = [];
  for (const candidate of candidateList) {
    let identityScore = 0;
    let coverageScore = 0;
    let proximityScore = 0;

    for (const field of ORAMA_SEARCH_FIELDS) {
      identityScore += fieldIdentityScore(candidate.document, field, analysis.phrases);
      const fieldWeight = ORAMA_FIELD_PRIORITY[field];
      const coverageWeight = field === 'body' ? fieldWeight * 0.45 : fieldWeight;
      coverageScore += fieldQueryCoverage(candidate.document, field, queryTerms) * coverageWeight;
      proximityScore = Math.max(
        proximityScore,
        fieldProximityScore(candidate.document, field, queryTerms) * fieldWeight,
      );
    }

    let rarityScore = 0;
    for (const term of candidateTerms.get(candidate.document.entryId) ?? []) {
      rarityScore += 1 / (termDocumentFrequency.get(term) ?? 1);
    }

    const channelDiversityScore = candidate.channelHits.size * 0.03;
    const rawScore = Math.log1p(Math.max(0, candidate.bestRawScore)) * 0.01;
    ranked.push({
      document: candidate.document,
      score:
        candidate.score +
        identityScore +
        coverageScore * 0.18 +
        proximityScore * 0.12 +
        rarityScore * 0.06 +
        channelDiversityScore +
        rawScore,
    });
  }

  ranked.sort((left, right) =>
    compareScoreAndEntryId(
      { score: left.score, entryId: left.document.entryId },
      { score: right.score, entryId: right.document.entryId },
    ),
  );
  return ranked;
}

function isKbOramaDocument(document: unknown): document is KbOramaDocument {
  if (typeof document !== 'object' || document === null) {
    return false;
  }
  const candidate = document as { entryId?: unknown; kind?: unknown; title?: unknown; body?: unknown };
  return (
    typeof candidate.entryId === 'string' &&
    typeof candidate.kind === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.body === 'string'
  );
}

export function collectOramaDocumentsForFuzzyScan(
  db: KbOramaDb,
  limit = ORAMA_FUZZY_DOCUMENT_SCAN_LIMIT,
): OramaFuzzyDocumentScan {
  const storeDb = db as OramaDocumentStoreDb;
  const documents: KbOramaDocument[] = [];
  const storedDocuments = storeDb.documentsStore.getAll(storeDb.data.docs) as Record<string, unknown>;
  for (const key in storedDocuments) {
    if (!Object.prototype.hasOwnProperty.call(storedDocuments, key)) {
      continue;
    }
    const document = storedDocuments[key];
    if (!isKbOramaDocument(document)) {
      continue;
    }
    if (documents.length >= limit) {
      return { documents, truncated: true };
    }
    documents.push(document);
  }
  return { documents, truncated: false };
}

function isEditDistanceAtMostOne(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  if (Math.abs(left.length - right.length) > 1) {
    return false;
  }

  if (left.length === right.length) {
    let mismatches = 0;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
        mismatches += 1;
        if (mismatches > 1) {
          return false;
        }
      }
    }
    return true;
  }

  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  let shorterIndex = 0;
  let longerIndex = 0;
  let edits = 0;
  while (shorterIndex < shorter.length && longerIndex < longer.length) {
    if (shorter[shorterIndex] === longer[longerIndex]) {
      shorterIndex += 1;
      longerIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) {
      return false;
    }
    longerIndex += 1;
  }
  return true;
}

export function fuzzyDocumentScore(document: KbOramaDocument, terms: readonly string[]): number {
  let score = 0;
  for (const field of ORAMA_SEARCH_FIELDS) {
    const tokens = fieldTokens(document, field, field === 'body' ? FUZZY_BODY_TOKEN_SCAN_LIMIT : undefined);
    const fieldWeight = field === 'body' ? ORAMA_FIELD_PRIORITY[field] * 0.4 : ORAMA_FIELD_PRIORITY[field];
    for (const term of terms) {
      if (tokens.some((token) => isEditDistanceAtMostOne(term, token))) {
        score += fieldWeight;
      }
    }
  }
  return score;
}

function collectFuzzyOramaSearchCandidates(
  db: KbOramaDb,
  analysis: OramaSearchQueryAnalysis,
  limit: number,
  scope?: RetrievalScope,
): OramaCandidateCollection {
  if (analysis.fuzzy.length === 0) {
    return { candidates: new Map(), exhausted: true };
  }

  const fuzzyScan = collectOramaDocumentsForFuzzyScan(db);
  if (fuzzyScan.truncated) {
    // The fuzzy scan hit its hard document cap, which `limit` cannot raise. Report
    // exhausted so the KB-tier widening loop stops instead of doubling `limit`
    // forever against an empty, re-truncated result.
    return { candidates: new Map(), exhausted: true };
  }

  const matches = fuzzyScan.documents
    .filter((document) => scopeAllowsKind(scope, document.kind))
    .map((document) => ({ document, rawScore: fuzzyDocumentScore(document, analysis.fuzzy) }))
    .filter((match) => match.rawScore > 0)
    .sort((left, right) =>
      compareScoreAndEntryId(
        { score: left.rawScore, entryId: left.document.entryId },
        { score: right.rawScore, entryId: right.document.entryId },
      ),
    );

  const candidates = new Map<string, OramaCandidateAccumulator>();
  for (let index = 0; index < matches.length && index < limit; index += 1) {
    const match = matches[index];
    if (match === undefined) {
      continue;
    }
    candidates.set(match.document.entryId, {
      document: match.document,
      channelHits: new Set<OramaSearchChannel>(['surface']),
      score: ORAMA_SEARCH_FUZZY_MULTIPLIER / (ORAMA_SEARCH_RRF_K + index + 1),
      bestRawScore: match.rawScore,
    });
  }

  return { candidates, exhausted: matches.length <= limit };
}

async function collectOramaSearchCandidates(
  db: KbOramaDb,
  runs: readonly OramaSearchRun[],
  limit: number,
  scope?: RetrievalScope,
): Promise<OramaCandidateCollection> {
  const candidates = new Map<string, OramaCandidateAccumulator>();
  let exhausted = true;

  for (const run of runs) {
    if (run.terms.length === 0) {
      continue;
    }

    const response = await oramaSearch(db, {
      term: run.terms.join(' '),
      properties: [...ORAMA_SEARCH_CHANNEL_PROPERTIES[run.channel]],
      boost: ORAMA_SEARCH_CHANNEL_BOOST[run.channel],
      limit,
    });
    if (response.hits.length >= limit) {
      exhausted = false;
    }

    for (let index = 0; index < response.hits.length; index += 1) {
      const hit = response.hits[index];
      if (hit === undefined) {
        continue;
      }
      const document = hit.document as KbOramaDocument;
      if (!scopeAllowsKind(scope, document.kind)) {
        continue;
      }

      const entryId = document.entryId;
      const accumulator =
        candidates.get(entryId) ??
        ({
          document,
          channelHits: new Set<OramaSearchChannel>(),
          score: 0,
          bestRawScore: 0,
        } satisfies OramaCandidateAccumulator);
      const channelWeight = ORAMA_SEARCH_CHANNEL_WEIGHT[run.channel];
      accumulator.score += channelWeight / (ORAMA_SEARCH_RRF_K + index + 1);
      accumulator.bestRawScore = Math.max(accumulator.bestRawScore, hit.score);
      accumulator.channelHits.add(run.channel);
      candidates.set(entryId, accumulator);
    }
  }

  return { candidates, exhausted };
}

function mergeOramaCandidateCollections(
  primary: OramaCandidateCollection,
  fallback: OramaCandidateCollection,
): OramaCandidateCollection {
  const candidates = new Map(primary.candidates);

  for (const [entryId, fallbackCandidate] of fallback.candidates) {
    const primaryCandidate = candidates.get(entryId);
    if (primaryCandidate === undefined) {
      candidates.set(entryId, fallbackCandidate);
      continue;
    }
    primaryCandidate.score += fallbackCandidate.score;
    primaryCandidate.bestRawScore = Math.max(primaryCandidate.bestRawScore, fallbackCandidate.bestRawScore);
    for (const channel of fallbackCandidate.channelHits) {
      primaryCandidate.channelHits.add(channel);
    }
  }

  return { candidates, exhausted: primary.exhausted && fallback.exhausted };
}

export function toRetrievedDocument(document: KbOramaDocument): RetrievedDocument {
  return {
    entryId: document.entryId,
    slug: document.entryId.slice(document.entryId.indexOf(':') + 1),
    kind: document.kind,
    freshness: document.freshness,
    title: document.title,
    body: document.body,
    tags: document.tags,
    principles: document.principles,
  };
}

export async function collectRankedOramaSearchCandidates(
  db: KbOramaDb,
  analysis: OramaSearchQueryAnalysis,
  limit: number,
  scope?: RetrievalScope,
): Promise<{ readonly ranked: readonly OramaRankedCandidate[]; readonly exhausted: boolean }> {
  const primary = await collectOramaSearchCandidates(db, buildPrimarySearchRuns(analysis), limit, scope);
  const strict =
    primary.candidates.size >= limit
      ? primary
      : mergeOramaCandidateCollections(
          primary,
          await collectOramaSearchCandidates(db, buildNgramSearchRuns(analysis), limit, scope),
        );
  const collected = strict.candidates.size > 0 ? strict : collectFuzzyOramaSearchCandidates(db, analysis, limit, scope);
  return { ranked: rankOramaCandidates(collected.candidates.values(), analysis), exhausted: collected.exhausted };
}
