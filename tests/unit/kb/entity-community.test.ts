import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExistingGeneratedCommunity } from '#src/kb/curate/community-detection.js';
import type { KbIndex } from '#src/kb/entry-types.js';

async function loadCommunityDetectionWithMock(
  mockDetailed?: () => {
    communities: Record<string, number>;
    modularity: number;
    dendrogram: ArrayLike<number>[];
  },
) {
  vi.resetModules();
  if (mockDetailed === undefined) {
    vi.unmock('graphology-communities-louvain');
  } else {
    vi.doMock('graphology-communities-louvain', () => ({
      default: {
        detailed: mockDetailed,
      },
    }));
  }

  return import('#src/kb/curate/community-detection.js');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock('graphology-communities-louvain');
});

describe('entity-community', () => {
  it('reduces directed relationships into a deterministic undirected graph, dropping self loops and deduping evidence', async () => {
    const { buildEntityRelationshipGraph } = await loadCommunityDetectionWithMock();
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
          description: 'Beta points back to alpha.',
          evidence: ['note:3'],
        },
        {
          source: 'beta',
          target: 'beta',
          type: 'implements',
          description: 'Self loops should not survive.',
          evidence: ['note:4'],
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
  });

  it('maps dendrogram pointer arrays back to entity names and carries hierarchy-aware slugs across runs', async () => {
    const { buildEntityRelationshipGraph, detectCommunities } = await loadCommunityDetectionWithMock(() => ({
      communities: {
        alpha: 0,
        beta: 0,
        gamma: 1,
        omega: 1,
      },
      modularity: 0.61,
      dendrogram: [
        Uint32Array.from([0, 1, 2, 3]),
        Uint32Array.from([0, 0, 1, 1]),
        Uint32Array.from([0, 0, 0, 0]),
      ],
    }));
    const graph = buildEntityRelationshipGraph({
      entityMeta: {
        alpha: { type: 'concept', description: 'Alpha.' },
        beta: { type: 'concept', description: 'Beta.' },
        gamma: { type: 'concept', description: 'Gamma.' },
        omega: { type: 'concept', description: 'Omega.' },
      },
      relationships: [
        {
          source: 'alpha',
          target: 'beta',
          type: 'enables',
          description: 'Alpha links to beta.',
          evidence: ['note:1'],
        },
        {
          source: 'gamma',
          target: 'omega',
          type: 'enables',
          description: 'Gamma links to omega.',
          evidence: ['note:2'],
        },
      ],
    });
    const priorCommunities: ExistingGeneratedCommunity[] = [
      {
        slug: 'alpha-beta-legacy',
        title: 'Alpha / Beta',
        level: 0,
        members: ['alpha', 'beta'],
        parent: 'community:all-topics',
        createdAt: '2026-04-02',
        updatedAt: '2026-04-02',
      },
      {
        slug: 'gamma-omega-legacy',
        title: 'Gamma / Omega',
        level: 0,
        members: ['gamma', 'omega'],
        parent: 'community:all-topics',
        createdAt: '2026-04-02',
        updatedAt: '2026-04-02',
      },
      {
        slug: 'all-topics',
        title: 'All Topics',
        level: 1,
        members: ['alpha', 'beta', 'gamma', 'omega'],
        children: ['community:alpha-beta-legacy', 'community:gamma-omega-legacy'],
        createdAt: '2026-04-02',
        updatedAt: '2026-04-02',
      },
    ];

    const communities = detectCommunities(graph, { priorCommunities });

    expect(communities).toEqual([
      expect.objectContaining({
        slug: 'alpha-beta-legacy',
        level: 0,
        members: ['alpha', 'beta'],
        parent: 'community:all-topics',
      }),
      expect.objectContaining({
        slug: 'gamma-omega-legacy',
        level: 0,
        members: ['gamma', 'omega'],
        parent: 'community:all-topics',
      }),
      expect.objectContaining({
        slug: 'all-topics',
        level: 1,
        members: ['alpha', 'beta', 'gamma', 'omega'],
        children: ['community:alpha-beta-legacy', 'community:gamma-omega-legacy'],
      }),
    ]);
  });

  it('invalidates leaf fingerprints on entity metadata changes and parent fingerprints on child summary changes', async () => {
    const { computeCommunitySummaryInputFingerprints } = await loadCommunityDetectionWithMock();
    const kb = {
      notePath(slug: string) {
        return `/tmp/${slug}.md`;
      },
      sourcePath(slug: string) {
        return `/tmp/${slug}.md`;
      },
    };
    const communities = [
      {
        slug: 'leaf',
        title: 'Leaf',
        level: 0,
        members: ['graph-rag'],
        summary: 'Leaf summary.',
      },
      {
        slug: 'parent',
        title: 'Parent',
        level: 1,
        members: ['graph-rag'],
        children: ['community:leaf'],
        summary: 'Parent summary.',
      },
    ];
    const index: KbIndex = {
      entries: {},
      principles: {},
      entityMeta: {
        'graph-rag': {
          type: 'concept',
          description: 'Graph-backed retrieval.',
        },
      },
      relationships: [],
    };

    const baseline = computeCommunitySummaryInputFingerprints(communities, kb, index);
    const changedLeaf = computeCommunitySummaryInputFingerprints(communities, kb, {
      ...index,
      entityMeta: {
        'graph-rag': {
          type: 'concept',
          description: 'Updated graph-backed retrieval description.',
        },
      },
    });
    const changedParent = computeCommunitySummaryInputFingerprints(
      [
        {
          ...communities[0],
          summary: 'Leaf summary changed.',
        },
        communities[1],
      ],
      kb,
      index,
    );

    expect(changedLeaf.leaf).not.toBe(baseline.leaf);
    expect(changedLeaf.parent).toBe(baseline.parent);
    expect(changedParent.leaf).toBe(baseline.leaf);
    expect(changedParent.parent).not.toBe(baseline.parent);
  });
});
