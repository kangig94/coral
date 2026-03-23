import { describe, expect, it } from 'vitest';
import {
  deriveNoteIdentity,
  extractTitle,
  parseFrontmatter,
  parseMemoFrontmatter,
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
---
# KB Contract
`;

    expect(parseFrontmatter(content)).toEqual({
      tags: ['coral', 'kb'],
      principles: ['lenient-read-strict-write', 'contract-first-design'],
      source: ['kangig94/coral'],
      createdAt: '2026-03-23',
      updatedAt: '2026-03-23',
    });
  });

  it('writes canonical bare principle references', () => {
    const serialized = serializeFrontmatter({
      tags: ['coral', 'kb'],
      principles: ['[[lenient-read-strict-write]]', 'contract-first-design'],
      source: ['kangig94/coral'],
      createdAt: '2026-03-23',
      updatedAt: '2026-03-23',
    });

    expect(serialized).not.toContain('[[lenient-read-strict-write]]');
    expect(serialized).toContain('lenient-read-strict-write');
    expect(parseFrontmatter(`${serialized}# Title\n`)).toMatchObject({
      principles: ['lenient-read-strict-write', 'contract-first-design'],
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

  it('extracts titles and filename-derived identities', () => {
    const note = serializeNote({
      tags: ['coral'],
      principles: ['contract-first-design'],
      source: ['kangig94/coral'],
      createdAt: '2026-03-23',
      updatedAt: '2026-03-23',
    }, 'KB Runtime Root', '## Rule\nUse the configured root.');

    expect(extractTitle(note)).toBe('KB Runtime Root');
    expect(deriveNoteIdentity('/tmp/coral-kb-runtime-root.md')).toEqual({
      note: 'coral-kb-runtime-root',
      domain: 'coral',
      topic: 'kb-runtime-root',
    });
  });
});
