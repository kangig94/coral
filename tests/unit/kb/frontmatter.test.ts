import { describe, expect, it, vi } from 'vitest';
import {
  deriveNoteIdentity,
  extractTitle,
  parseCommunityFrontmatter,
  parseFrontmatter,
  parseMemoFrontmatter,
  parseSourceFrontmatter,
  replaceFrontmatter,
  serializeCommunityFrontmatter,
  serializeFrontmatter,
  serializeNote,
  serializeSourceFrontmatter,
} from '#src/kb/corpus/frontmatter.js';

describe('kb frontmatter', () => {
  it('reads wikilink and bare principle references as bare names', () => {
    const content = `---
tags: [coral, kb]
principles:
  - "[[lenient-read-strict-write]]"
  - contract-first-design
source:
  - kangig94/coral
createdAt: 2026-03-23
updatedAt: 2026-03-23
entrySeq: 11
---
# KB Contract
`;

    expect(parseFrontmatter(content)).toEqual({
      tags: ['coral', 'kb'],
      principles: ['lenient-read-strict-write', 'contract-first-design'],
      source: ['kangig94/coral'],
      createdAt: '2026-03-23',
      updatedAt: '2026-03-23',
      related: [],
      entrySeq: 11,
    });
  });

  it('writes canonical bare principle references', () => {
    const serialized = serializeFrontmatter({
      tags: ['coral', 'kb'],
      principles: ['[[lenient-read-strict-write]]', 'contract-first-design'],
      source: ['kangig94/coral'],
      createdAt: '2026-03-23',
      updatedAt: '2026-03-23',
      entrySeq: 17,
    });

    expect(serialized).not.toContain('[[lenient-read-strict-write]]');
    expect(serialized).toContain('lenient-read-strict-write');
    expect(parseFrontmatter(`${serialized}# Title\n`)).toMatchObject({
      principles: ['lenient-read-strict-write', 'contract-first-design'],
      entrySeq: 17,
    });
  });

  it('accepts note frontmatter with no entry sequence', () => {
    const content = `---
tags: [coral]
principles: []
source:
  - kangig94/coral
createdAt: 2026-03-23
updatedAt: 2026-03-23
---
# Legacy Note
`;

    expect(parseFrontmatter(content)).toEqual({
      tags: ['coral'],
      principles: [],
      source: ['kangig94/coral'],
      createdAt: '2026-03-23',
      updatedAt: '2026-03-23',
      related: [],
    });
  });

  it('parses and serializes source frontmatter separately from note frontmatter', () => {
    const serialized = serializeSourceFrontmatter({
      title: 'SQLite Query Planner Overview',
      type: 'spec',
      tags: ['database', 'query-planning'],
      url: 'https://sqlite.org/queryplanner.html',
      importedAt: '2026-03-23T00:00:00.000Z',
      entrySeq: 29,
      related: ['note:query-planner', 'source:sqlite-overview'],
    });

    expect(parseSourceFrontmatter(`${serialized}# SQLite Query Planner Overview\n\nBody.\n`)).toEqual({
      title: 'SQLite Query Planner Overview',
      type: 'spec',
      tags: ['database', 'query-planning'],
      url: 'https://sqlite.org/queryplanner.html',
      importedAt: '2026-03-23T00:00:00.000Z',
      entrySeq: 29,
      related: ['note:query-planner', 'source:sqlite-overview'],
    });
  });

  it('parses and serializes community frontmatter with hierarchy metadata', () => {
    const serialized = serializeCommunityFrontmatter({
      createdAt: '2026-04-02',
      updatedAt: '2026-04-03',
      level: 1,
      parent: 'community:platform-architecture',
      children: ['community:graph-rag-leaf', 'community:retrieval-leaf'],
    });

    expect(parseCommunityFrontmatter(`${serialized}# Graph RAG\n\nBody.\n`)).toEqual({
      createdAt: '2026-04-02',
      updatedAt: '2026-04-03',
      level: 1,
      parent: 'community:platform-architecture',
      children: ['community:graph-rag-leaf', 'community:retrieval-leaf'],
    });
  });

  it('normalizes memo source frontmatter from scalar and array forms', () => {
    const scalarMemo = `---
source: kangig94/coral
---
memo
`;
    const arrayMemo = `---
source:
  - kangig94/coral
---
memo
`;

    expect(parseMemoFrontmatter(scalarMemo)).toEqual({ source: ['kangig94/coral'] });
    expect(parseMemoFrontmatter(arrayMemo)).toEqual({ source: ['kangig94/coral'] });
  });

  it('replaces only the frontmatter block and preserves the remaining note bytes', () => {
    const content = `---
tags: [coral]
principles: []
source:
  - kangig94/coral
createdAt: 2026-03-23
updatedAt: 2026-03-23
---
# KB Contract

## Rule
Keep the body stable.
`;
    const meta = {
      tags: ['coral', 'kb'],
      principles: ['contract-first-design'],
      source: ['kangig94/coral'],
      createdAt: '2026-03-23',
      updatedAt: '2026-03-24',
      entrySeq: 19,
    };

    expect(replaceFrontmatter(content, meta)).toBe(`${serializeFrontmatter(meta)}# KB Contract

## Rule
Keep the body stable.
`);
  });

  it('extracts titles and filename-derived identities', () => {
    const note = serializeNote(
      {
        tags: ['coral'],
        principles: ['contract-first-design'],
        source: ['kangig94/coral'],
        createdAt: '2026-03-23',
        updatedAt: '2026-03-23',
        entrySeq: 23,
      },
      'KB Runtime Root',
      '## Rule\nUse the configured root.',
    );

    expect(extractTitle(note)).toBe('KB Runtime Root');
    expect(deriveNoteIdentity('/tmp/coral-kb-runtime-root.md')).toEqual({
      note: 'coral-kb-runtime-root',
      domain: 'coral',
      topic: 'kb-runtime-root',
    });
  });

  it('markTextIndexStale logs to stderr on double failure instead of silently swallowing', async () => {
    const { markTextIndexStale } = await import('#src/kb/corpus/index-mutations.js');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const alwaysThrows = () => {
      throw new Error('disk full');
    };
    markTextIndexStale(alwaysThrows, 'stale after promote');

    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stderrSpy.mock.calls[0][0]).toContain('markTextIndexStale');
    expect(stderrSpy.mock.calls[0][0]).toContain('disk full');
    stderrSpy.mockRestore();
  });

  it('imports frontmatter and mutation helpers through validation without a circular load failure', async () => {
    vi.resetModules();
    const [{ parseFrontmatter: dynamicParseFrontmatter }, { buildNoteIndexEntry }, { assertNonEmptyText }] =
      await Promise.all([
        import('#src/kb/corpus/frontmatter.js'),
        import('#src/kb/corpus/index-records.js'),
        import('#src/kb/validation.js'),
      ]);

    expect(
      dynamicParseFrontmatter(`---
tags: [coral]
principles: []
source:
  - kangig94/coral
createdAt: 2026-03-23
updatedAt: 2026-03-23
---
# Dynamic Import
`),
    ).toMatchObject({
      createdAt: '2026-03-23',
      updatedAt: '2026-03-23',
    });
    expect(
      buildNoteIndexEntry({
        slug: 'coral-test',
        title: 'Test',
        tags: ['coral'],
        principles: [],
        source: ['test'],
        createdAt: '2026-03-23',
        updatedAt: '2026-03-23',
      }),
    ).toMatchObject({ title: 'Test', tags: ['coral'] });
    expect(assertNonEmptyText(' title ', 'title')).toBe('title');
  });
});
