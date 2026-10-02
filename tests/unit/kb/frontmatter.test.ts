import { describe, expect, it } from 'vitest';
import { parseWikiBody, replaceFrontmatter, serializeFrontmatter } from '#src/kb/corpus/frontmatter.js';

describe('kb frontmatter', () => {
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

  describe('parseWikiBody', () => {
    const sampleBody = [
      '## Understanding',
      '',
      'First understanding paragraph.',
      '',
      'Second understanding paragraph.',
      '',
      '## Knowledge',
      '',
      '- [[notes/alpha]]',
      '  - 2026-04-01 seed evidence for alpha',
      '- [[notes/beta]]',
    ].join('\n');

    it.each([
      ['Understanding', sampleBody.replace('## Understanding', '## understanding-typo')],
      ['Knowledge', sampleBody.replace('## Knowledge', '## knowledge-typo')],
    ])('throws when the %s header is missing', (header, malformed) => {
      expect(() => parseWikiBody(malformed)).toThrow(`Wiki body is missing ## ${header} header`);
    });
  });
});
