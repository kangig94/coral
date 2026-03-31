import { describe, expect, it, vi } from 'vitest';
import {
  deriveNoteIdentity,
  extractTitle,
  parseFrontmatter,
  parseMemoFrontmatter,
  replaceFrontmatter,
  serializeFrontmatter,
  serializeNote,
} from '../frontmatter.js';

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
mutationSeqAtPromote: 11
---
# KB Contract
`;

    expect(parseFrontmatter(content)).toEqual({
      tags: ['coral', 'kb'],
      principles: ['lenient-read-strict-write', 'contract-first-design'],
      source: ['kangig94/coral'],
      createdAt: '2026-03-23',
      updatedAt: '2026-03-23',
      mutationSeqAtPromote: 11,
    });
  });

  it('writes canonical bare principle references', () => {
    const serialized = serializeFrontmatter({
      tags: ['coral', 'kb'],
      principles: ['[[lenient-read-strict-write]]', 'contract-first-design'],
      source: ['kangig94/coral'],
      createdAt: '2026-03-23',
      updatedAt: '2026-03-23',
      mutationSeqAtPromote: 17,
    });

    expect(serialized).not.toContain('[[lenient-read-strict-write]]');
    expect(serialized).toContain('lenient-read-strict-write');
    expect(parseFrontmatter(`${serialized}# Title\n`)).toMatchObject({
      principles: ['lenient-read-strict-write', 'contract-first-design'],
      mutationSeqAtPromote: 17,
    });
  });

  it('accepts legacy note frontmatter with no mutation sequence', () => {
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
      mutationSeqAtPromote: 19,
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
        mutationSeqAtPromote: 23,
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
    const { markTextIndexStale } = await import('../mutation-helpers.js');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const alwaysThrows = () => {
      throw new Error('disk full');
    };
    markTextIndexStale(alwaysThrows, 'stale after promote');

    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stderrSpy.mock.calls[0]![0]).toContain('markTextIndexStale');
    expect(stderrSpy.mock.calls[0]![0]).toContain('disk full');
    stderrSpy.mockRestore();
  });

  it('imports frontmatter and mutation helpers through validation without a circular load failure', async () => {
    vi.resetModules();
    const [{ parseFrontmatter: dynamicParseFrontmatter }, { buildNoteIndexEntry }, { assertNonEmptyText }] =
      await Promise.all([import('../frontmatter.js'), import('../mutation-helpers.js'), import('../validation.js')]);

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
