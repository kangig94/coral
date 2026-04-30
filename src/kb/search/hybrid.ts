import type {
  FusedResult,
  FusedRetrievalHit,
  GraphRetrievalResult,
  HybridFusion,
  TextRetrievalResult,
  VectorRetrievalResult,
} from './contract.js';

export const HYBRID_RRF_K = 60;
// Graph hits stay as an explicit third retrieval role. They are ranked by their
// graph search result order and contribute a weighted RRF term so graph evidence
// survives hybrid routing without overwhelming text/vector consensus.
export const GRAPH_RRF_WEIGHT = 0.22;

function rrfScore(rank: number): number {
  return 1 / (HYBRID_RRF_K + rank);
}

function compareFusedHits(left: FusedRetrievalHit, right: FusedRetrievalHit): number {
  const scoreDelta = right.score - left.score;
  if (Math.abs(scoreDelta) > 1e-12) {
    return scoreDelta;
  }
  return left.entryId.localeCompare(right.entryId);
}

export class ReciprocalRankFusion implements HybridFusion {
  fuse(text: TextRetrievalResult, vector: VectorRetrievalResult, graph: GraphRetrievalResult): FusedResult {
    const fused = new Map<FusedRetrievalHit['entryId'], FusedRetrievalHit>();

    for (const hit of text.hits) {
      fused.set(hit.entryId, {
        entryId: hit.entryId,
        slug: hit.slug,
        kind: hit.kind,
        title: hit.title,
        tags: [...hit.tags],
        principles: [...hit.principles],
        rank: 0,
        score: rrfScore(hit.rank),
        document: hit.document,
        textRank: hit.rank,
      });
    }

    for (const hit of vector.hits) {
      const previous = fused.get(hit.entryId);
      if (previous === undefined) {
        fused.set(hit.entryId, {
          entryId: hit.entryId,
          slug: hit.slug,
          kind: hit.kind,
          title: hit.title,
          tags: [...hit.tags],
          principles: [...hit.principles],
          rank: 0,
          score: rrfScore(hit.rank),
          document: null,
          vectorRank: hit.rank,
        });
        continue;
      }

      fused.set(hit.entryId, {
        ...previous,
        score: previous.score + rrfScore(hit.rank),
        vectorRank: hit.rank,
      });
    }

    for (const hit of graph.hits) {
      const previous = fused.get(hit.entryId);
      const contribution = GRAPH_RRF_WEIGHT * rrfScore(hit.rank);
      if (previous === undefined) {
        fused.set(hit.entryId, {
          entryId: hit.entryId,
          slug: hit.slug,
          kind: hit.kind,
          title: hit.title,
          tags: [...hit.tags],
          principles: [...hit.principles],
          rank: 0,
          score: contribution,
          document: null,
          graphRank: hit.rank,
        });
        continue;
      }

      fused.set(hit.entryId, {
        ...previous,
        score: previous.score + contribution,
        graphRank: hit.rank,
      });
    }

    return {
      hits: [...fused.values()].sort(compareFusedHits).map((hit, index) => ({
        ...hit,
        rank: index + 1,
      })),
    };
  }
}

/** Creates the project-standard hybrid ranker that blends text, vector, and graph evidence. */
export function createHybridFusion(): HybridFusion {
  return new ReciprocalRankFusion();
}
