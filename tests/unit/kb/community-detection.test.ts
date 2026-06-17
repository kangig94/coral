import { describe, expect, it } from 'vitest';
import { detectCommunities, normalizeCommunityModularity } from '#src/kb/curate/community/detection.js';
import { buildEntityRelationshipGraph } from '#src/kb/curate/community/graph.js';
import { renderCommunityDocument } from '#src/kb/curate/community/documents.js';
import type { ExistingGeneratedCommunity } from '#src/kb/curate/community/contracts.js';
import {
  extractBody,
  parseCommunityFrontmatter,
  parseMembersFromBody,
  parseSummaryFromBody,
} from '#src/kb/corpus/frontmatter.js';
import type { EntityGraph } from '#src/kb/entry-types.js';

function createEntityGraph(): EntityGraph {
  return {
    entityMeta: {
      'graph-rag': {
        type: 'concept',
        description: 'Graph-backed retrieval.',
      },
      retrieval: {
        type: 'operation',
        description: 'Retrieval workflows.',
      },
      indexing: {
        type: 'operation',
        description: 'Index maintenance.',
      },
      embeddings: {
        type: 'technology',
        description: 'Vector embeddings.',
      },
    },
    relationships: [
      {
        source: 'graph-rag',
        target: 'retrieval',
        type: 'enables',
        description: 'Graph structure improves retrieval.',
        evidence: ['note:graph-rag-1', 'note:graph-rag-2'],
      },
      {
        source: 'retrieval',
        target: 'indexing',
        type: 'requires',
        description: 'Retrieval depends on indexes.',
        evidence: ['note:graph-rag-2'],
      },
      {
        source: 'embeddings',
        target: 'retrieval',
        type: 'enables',
        description: 'Embeddings support retrieval.',
        evidence: ['note:graph-rag-3'],
      },
    ],
  };
}

describe('community-detection', () => {
  it('builds the entity relationship graph from canonical entity metadata and relationship evidence', () => {
    const graph = buildEntityRelationshipGraph({
      entityMeta: {
        alpha: { type: 'concept', description: 'Alpha.' },
        beta: { type: 'concept', description: 'Beta.' },
        gamma: { type: 'concept', description: 'Gamma.' },
      },
      relationships: [
        {
          source: 'alpha',
          target: 'beta',
          type: 'enables',
          description: 'Alpha enables beta.',
          evidence: ['note:1', 'note:1', 'note:2'],
        },
        {
          source: 'beta',
          target: 'alpha',
          type: 'requires',
          description: 'Beta also points back to alpha.',
          evidence: ['note:3'],
        },
        {
          source: 'beta',
          target: 'beta',
          type: 'implements',
          description: 'Self loops are ignored.',
          evidence: ['note:4'],
        },
        {
          source: 'gamma',
          target: 'missing',
          type: 'enables',
          description: 'Missing endpoints are ignored.',
          evidence: ['note:5'],
        },
      ],
    });

    expect(graph.tags).toEqual(['alpha', 'beta', 'gamma']);
    expect(graph.edges).toEqual([
      {
        left: 'alpha',
        right: 'beta',
        weight: 3,
      },
    ]);
    expect(graph.adjacency.get('alpha')?.get('beta')).toBe(3);
    expect(graph.adjacency.get('beta')?.get('alpha')).toBe(3);
    expect(graph.adjacency.get('beta')?.has('beta')).toBe(false);
  });

  it('detects stable communities for the same entity graph across repeated runs', () => {
    const graph = buildEntityRelationshipGraph(createEntityGraph());

    const first = detectCommunities(graph);
    const second = detectCommunities(graph);

    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);

    for (const community of first) {
      expect(community.members).toEqual([...community.members].sort((left, right) => left.localeCompare(right)));
      if (community.parent !== undefined) {
        expect(first.some((candidate) => `community:${candidate.slug}` === community.parent)).toBe(true);
      }
      for (const child of community.children ?? []) {
        expect(first.some((candidate) => `community:${candidate.slug}` === child)).toBe(true);
      }
    }
  });

  it('is byte-stable for a fixed graph plus prior community state pair', () => {
    const graph = buildEntityRelationshipGraph(createEntityGraph());
    const priorCommunities: ExistingGeneratedCommunity[] = [
      {
        slug: 'retrieval-stack',
        title: 'Retrieval / Graph RAG / Embeddings',
        level: 0,
        members: ['embeddings', 'graph-rag', 'indexing', 'retrieval'],
        createdAt: '2026-04-02',
        updatedAt: '2026-04-02',
      },
    ];
    const reservedSlugs = new Set(['embeddings']);
    const outputs = new Set<string>();

    for (let index = 0; index < 8; index += 1) {
      outputs.add(
        JSON.stringify(
          detectCommunities(graph, {
            priorCommunities,
            reservedSlugs,
          }),
        ),
      );
    }

    expect(outputs.size).toBe(1);
    expect([...outputs][0]).toContain('retrieval-stack');
  });

  it('rounds modularity comparisons to avoid architecture-sized floating point drift', () => {
    expect(normalizeCommunityModularity(0.1234567890123)).toBe(
      normalizeCommunityModularity(0.1234567890124),
    );
    expect(normalizeCommunityModularity(0.1234567890129)).not.toBe(
      normalizeCommunityModularity(0.1234567890139),
    );
  });

  it('renders and parses hierarchy metadata and summary sections round-trip', () => {
    const rendered = renderCommunityDocument({
      title: 'Graph RAG',
      level: 1,
      members: ['graph-rag', 'retrieval'],
      parent: 'community:platform-architecture',
      children: ['community:graph-rag-leaf', 'community:retrieval-leaf'],
      summary: 'Shared graph-backed retrieval patterns.',
      createdAt: '2026-04-02',
      updatedAt: '2026-04-03',
    });

    const body = extractBody(rendered);

    expect(parseCommunityFrontmatter(rendered)).toEqual({
      createdAt: '2026-04-02',
      updatedAt: '2026-04-03',
      level: 1,
      parent: 'community:platform-architecture',
      children: ['community:graph-rag-leaf', 'community:retrieval-leaf'],
    });
    expect(parseMembersFromBody(body)).toEqual(['graph-rag', 'retrieval']);
    expect(parseSummaryFromBody(body)).toBe('Shared graph-backed retrieval patterns.');
    expect(rendered).toContain('## Children');
    expect(rendered).toContain('- community:graph-rag-leaf');
    expect(rendered).toContain('- community:retrieval-leaf');
  });
});
