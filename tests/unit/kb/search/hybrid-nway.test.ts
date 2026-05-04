import { describe, expect, it } from 'vitest';

import { defaultFusionProfile } from '#src/kb/search/default-fusion-profile.js';
import { createHybridFusion } from '#src/kb/search/hybrid.js';
import type {
  RegisteredRetrievalRole,
  RetrievalHit,
  RetrievalRoleDescriptor,
  RoleExecutionResult,
} from '#src/kb/search/contract.js';

function noteHit(entryId: `note:${string}`, rank: number): RetrievalHit {
  const slug = entryId.slice('note:'.length);
  return {
    entryId,
    slug,
    kind: 'note',
    title: slug.toUpperCase(),
    tags: [],
    principles: [],
    rank,
    score: 1,
    document: {
      entryId,
      slug,
      kind: 'note',
      freshness: 'fresh',
      title: slug.toUpperCase(),
      body: `${slug} body`,
      tags: [],
      principles: [],
    },
  };
}

function roleResult(
  id: string,
  tags: readonly string[],
  hits: readonly RetrievalHit[],
  options: {
    readonly label?: string;
    readonly origin?: RegisteredRetrievalRole['origin'];
    readonly criticality?: RegisteredRetrievalRole['criticality'];
  } = {},
): RoleExecutionResult {
  const descriptor: RetrievalRoleDescriptor = {
    id,
    label: options.label ?? id,
    tags: [...tags],
    phase: 'retrieval-source',
    supportsScopes: ['notes', 'sources', 'communities', 'all'],
    provides: 'retrieval-source',
  };
  return {
    registeredRole: {
      role: {
        id,
        descriptor,
        async search() {
          return { hits: [] };
        },
      },
      descriptor,
      origin: options.origin ?? 'builtin',
      permanence: options.origin === 'external' ? 'scoped' : 'runtime',
      ...(options.criticality === undefined ? {} : { criticality: options.criticality }),
    },
    hits: [...hits],
  };
}

describe('hybrid N-way reciprocal rank fusion', () => {
  it('scores a one-way text role as 1 / (60 + rank)', () => {
    const fused = createHybridFusion().fuse(
      [roleResult('text', ['lexical'], [noteHit('note:alpha', 1), noteHit('note:beta', 2)])],
      defaultFusionProfile,
    );

    expect(fused.hits.map((hit) => hit.entryId)).toEqual(['note:alpha', 'note:beta']);
    expect(fused.hits[0]?.score).toBe(1 / 61);
    expect(fused.hits[0]?.evidence).toEqual([
      {
        roleId: 'text',
        label: 'text',
        rank: 1,
        weight: 1,
        contribution: 1 / 61,
      },
    ]);
    expect(fused.hits[1]?.score).toBe(1 / 62);
  });

  it('scores two equal-weight roles with a shared rank-1 document as 2 / 61', () => {
    const fused = createHybridFusion().fuse(
      [
        roleResult('text', ['lexical'], [noteHit('note:shared', 1)]),
        roleResult('vector', ['semantic'], [noteHit('note:shared', 1)]),
      ],
      defaultFusionProfile,
    );

    expect(fused.hits.map((hit) => hit.entryId)).toEqual(['note:shared']);
    expect(fused.hits[0]?.score).toBe(1 / 61 + 1 / 61);
    expect(fused.hits[0]?.evidence.map((item) => item.contribution)).toEqual([1 / 61, 1 / 61]);
  });

  it('scores the default text/vector/graph rank-1 case with the graph 0.22 override', () => {
    const fused = createHybridFusion().fuse(
      [
        roleResult('text', ['lexical'], [noteHit('note:shared', 1)]),
        roleResult('vector', ['semantic'], [noteHit('note:shared', 1)]),
        roleResult('graph', ['structural'], [noteHit('note:shared', 1)], { criticality: undefined }),
      ],
      defaultFusionProfile,
    );

    expect(fused.hits.map((hit) => hit.entryId)).toEqual(['note:shared']);
    expect(fused.hits[0]?.score).toBe(1 / 61 + 1 / 61 + 0.22 / 61);
    expect(fused.hits[0]?.evidence.map((item) => [item.roleId, item.weight, item.contribution])).toEqual([
      ['text', 1, 1 / 61],
      ['vector', 1, 1 / 61],
      ['graph', 0.22, 0.22 / 61],
    ]);
  });

  it('keeps N=10 ordering stable without drifting from deterministic accumulation', () => {
    const roleResults = Array.from({ length: 10 }, (_, index) =>
      roleResult(
        `role-${index}`,
        ['lexical'],
        [noteHit('note:shared', 1), noteHit(`note:unique-${index}` as `note:${string}`, 2)],
      ),
    );
    const fused = createHybridFusion().fuse(roleResults, defaultFusionProfile);

    expect(fused.hits.map((hit) => hit.entryId)).toEqual([
      'note:shared',
      'note:unique-0',
      'note:unique-1',
      'note:unique-2',
      'note:unique-3',
      'note:unique-4',
      'note:unique-5',
      'note:unique-6',
      'note:unique-7',
      'note:unique-8',
      'note:unique-9',
    ]);
    expect(fused.hits[0]?.score).toBe(Array.from({ length: 10 }).reduce<number>((score) => score + 1 / 61, 0));
    expect(fused.hits[0]?.evidence).toHaveLength(10);
    expect(fused.hits.at(-1)?.score).toBe(1 / 62);
  });

  it('pins the exact default-profile regression vector with per-role contributions', () => {
    const fused = createHybridFusion().fuse(
      [
        roleResult('text', ['lexical'], [noteHit('note:a', 1), noteHit('note:b', 2), noteHit('note:c', 3)]),
        roleResult('vector', ['semantic'], [noteHit('note:c', 1), noteHit('note:a', 2), noteHit('note:d', 3)]),
        roleResult('graph', ['structural'], [noteHit('note:b', 1), noteHit('note:a', 2), noteHit('note:e', 3)]),
      ],
      defaultFusionProfile,
    );

    expect(fused.hits.map((hit) => hit.entryId)).toEqual(['note:a', 'note:c', 'note:b', 'note:d', 'note:e']);
    expect(fused.hits.map((hit) => hit.score)).toEqual([
      1 / 61 + 1 / 62 + 0.22 / 62,
      1 / 63 + 1 / 61,
      1 / 62 + 0.22 / 61,
      1 / 63,
      0.22 / 63,
    ]);
    expect(
      fused.hits.map((hit) => hit.evidence.map((item) => [item.roleId, item.rank, item.weight, item.contribution])),
    ).toEqual([
      [
        ['text', 1, 1, 1 / 61],
        ['vector', 2, 1, 1 / 62],
        ['graph', 2, 0.22, 0.22 / 62],
      ],
      [
        ['text', 3, 1, 1 / 63],
        ['vector', 1, 1, 1 / 61],
      ],
      [
        ['text', 2, 1, 1 / 62],
        ['graph', 1, 0.22, 0.22 / 61],
      ],
      [['vector', 3, 1, 1 / 63]],
      [['graph', 3, 0.22, 0.22 / 63]],
    ]);
  });
});
