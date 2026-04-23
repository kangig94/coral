import { insertMultiple } from '@orama/orama';
import { describe, expect, it, vi } from 'vitest';

import type { KbRuntime } from '#src/kb/contracts.js';
import type { KbEntryId } from '#src/kb/entry-types.js';

vi.mock('#src/kb/curate/state.js', () => ({
  readCurateState: () => ({
    communityTopologyHash: '',
    communitySummaryTopologyHash: '',
    communitySummaryInputFingerprints: {},
  }),
}));

vi.mock('#src/kb/curate/community-detection.js', () => ({
  computeCommunitySummaryInputFingerprints: () => ({}),
  computeCommunityTopologyFingerprint: () => '',
}));

vi.mock('#src/kb/corpus/frontmatter.js', () => ({
  extractBody: () => '',
  parseCommunityFrontmatter: () => ({
    createdAt: '2026-04-01',
    updatedAt: '2026-04-01',
    level: 1,
  }),
}));

vi.mock('#src/kb/corpus/index-records.js', () => ({
  cloneKbIndex: <T>(value: T): T => structuredClone(value),
}));

vi.mock('#src/kb/read.js', () => ({
  loadKbNote: () => {
    throw new Error('loadKbNote should not be called in orama-cosine.test.ts');
  },
  loadKbSource: () => {
    throw new Error('loadKbSource should not be called in orama-cosine.test.ts');
  },
}));

import { createOramaDb, OramaBaseProjection } from '#src/kb/search/orama-backend.js';

const RNG_SEED = 0xc05173;
const DIMENSIONS = 32;
const VECTOR_COUNT = 100;
const TOP_K = 10;

type TestDocument = {
  entryId: KbEntryId;
  vector: number[];
};

function createLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function normalizeVector(values: readonly number[]): number[] {
  let magnitude = 0;
  for (const value of values) {
    magnitude += value * value;
  }
  if (magnitude === 0) {
    throw new Error('Expected a non-zero vector.');
  }

  const scale = 1 / Math.sqrt(magnitude);
  return values.map((value) => value * scale);
}

function dot(left: readonly number[], right: readonly number[]): number {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += left[index] * right[index];
  }
  return total;
}

function cosine(left: readonly number[], right: readonly number[]): number {
  return dot(normalizeVector(left), normalizeVector(right));
}

function compareByScoreAndEntryId(
  left: { entryId: string; score: number },
  right: { entryId: string; score: number },
): number {
  const scoreDelta = right.score - left.score;
  if (Math.abs(scoreDelta) > 1e-12) {
    return scoreDelta;
  }
  return left.entryId.localeCompare(right.entryId);
}

function randomUnitVector(rng: () => number, dimensions: number): number[] {
  while (true) {
    const values = Array.from({ length: dimensions }, () => rng() * 2 - 1);
    let magnitude = 0;
    for (const value of values) {
      magnitude += value * value;
    }
    if (magnitude > 0) {
      return normalizeVector(values);
    }
  }
}

function createTestDocuments(vectors: readonly number[][]): TestDocument[] {
  return vectors.map((vector, index) => {
    const slug = `vec-${String(index).padStart(3, '0')}`;
    const entryId = `note:${slug}` as KbEntryId;
    return {
      entryId,
      vector: [...vector],
    };
  });
}

async function createProjection(documents: readonly TestDocument[]): Promise<OramaBaseProjection> {
  const { db, tokenizer } = await createOramaDb();
  await insertMultiple(
    db,
    documents.map(({ entryId, vector }) => ({
      id: entryId,
      entryId,
      slug: entryId.slice(entryId.indexOf(':') + 1),
      kind: 'note' as const,
      freshness: 'fresh' as const,
      title: entryId,
      body: entryId,
      tags: [],
      principles: [],
      contentHash: `content:${entryId}`,
      metadataHash: `metadata:${entryId}`,
      vector: [...vector],
    })),
  );

  const runtime = {
    async ensureOramaIndex() {
      return {
        db,
        tokenizer,
        index: {
          entries: {},
          principles: {},
        },
      };
    },
    getEquipmentView() {
      return {
        retrieval: projection,
        snapshotId: null,
        contentSeq: 0,
        contentManifestHash: null,
      };
    },
    getActiveVectorSurface() {
      return projection;
    },
    getBaseRetrievalSurface() {
      return projection;
    },
    getCorpusStateSnapshot() {
      return {
        snapshotId: 'orama-cosine-test-snapshot',
        contentSeq: 0,
        metadataSeq: 0,
        contentManifestHash: '',
        metadataManifestHash: '',
      };
    },
  } as unknown as KbRuntime;

  const projection = new OramaBaseProjection(runtime);
  return projection;
}

describe('OramaBaseProjection cosine search', () => {
  it('cosine top-k matches hand-computed within 1e-9 over 100 random unit vectors', async () => {
    const rng = createLcg(RNG_SEED);
    const vectors = Array.from({ length: VECTOR_COUNT }, () => randomUnitVector(rng, DIMENSIONS));
    const documents = createTestDocuments(vectors);
    const projection = await createProjection(documents);

    for (let queryIndex = 0; queryIndex < vectors.length; queryIndex += 1) {
      const query = vectors[queryIndex];
      const actual = await projection.search(query, TOP_K, 'all');
      const expected = documents
        .map((document) => ({
          entryId: document.entryId,
          score: cosine(query, document.vector),
        }))
        .sort(compareByScoreAndEntryId)
        .slice(0, TOP_K);

      expect(actual.hits).toHaveLength(TOP_K);
      expect(expected).toHaveLength(TOP_K);

      for (let rank = 0; rank < TOP_K; rank += 1) {
        const actualHit = actual.hits[rank];
        const expectedHit = expected[rank];
        expect(actualHit?.entryId).toBe(expectedHit?.entryId);
        expect(Math.abs((actualHit?.score ?? 0) - (expectedHit?.score ?? 0))).toBeLessThanOrEqual(1e-9);
      }
    }
  });

  it('rank stability under insertion permutation', async () => {
    const query = [1, 0, 0];
    const orderedDocuments = [
      {
        entryId: 'note:a' as KbEntryId,
        vector: normalizeVector([1, 0, 0]),
      },
      {
        entryId: 'note:b' as KbEntryId,
        vector: normalizeVector([0, 1, 0]),
      },
      {
        entryId: 'note:c' as KbEntryId,
        vector: normalizeVector([0.7071, 0.7071, 0]),
      },
    ] satisfies TestDocument[];

    const projectionAbc = await createProjection(orderedDocuments);
    const projectionCba = await createProjection([...orderedDocuments].reverse());

    const abc = await projectionAbc.search(query, 3, 'all');
    const cba = await projectionCba.search(query, 3, 'all');

    expect(abc.hits.map((hit) => hit.entryId)).toEqual(['note:a', 'note:c', 'note:b']);
    expect(cba.hits.map((hit) => hit.entryId)).toEqual(['note:a', 'note:c', 'note:b']);
    expect(abc.hits.map((hit) => hit.entryId)).toEqual(cba.hits.map((hit) => hit.entryId));
    expect(abc.hits[0]?.score).toBeCloseTo(1, 12);
    expect(abc.hits[1]?.score).toBeCloseTo(0.7071, 4);
    expect(abc.hits[2]?.score).toBeCloseTo(0, 12);
  });
});
