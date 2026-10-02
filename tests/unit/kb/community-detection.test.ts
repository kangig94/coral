import { describe, expect, it } from 'vitest';
import { buildEntityRelationshipGraph } from '#src/kb/curate/community/graph.js';
import { renderCommunityDocument } from '#src/kb/curate/community/documents.js';
import {
  extractBody,
  parseCommunityFrontmatter,
  parseMembersFromBody,
  parseSummaryFromBody,
} from '#src/kb/corpus/frontmatter.js';

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
