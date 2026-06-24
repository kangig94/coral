import { describe, expect, it, vi } from 'vitest';

import type { FtsRetrieval } from '#src/kb/contract.js';
import { extractSnippet } from '#src/kb/search/snippets.js';

function createTokenizingFts(onTokenize: (text: string) => readonly string[]): FtsRetrieval {
  return {
    search: async () => ({ hits: [], exhausted: true }),
    tokenize: vi.fn(async (text: string) => onTokenize(text)),
    warnings: () => [],
  };
}

describe('KB snippets', () => {
  it('token-anchor scanning tokenizes lazily and stops at the first matching word', async () => {
    const fts = createTokenizingFts((text) => [text.toLowerCase()]);
    const content = `needle ${'filler '.repeat(100_000)}`;

    const snippet = await extractSnippet(content, {
      rawQuery: 'not a phrase',
      normalizedQuery: 'not a phrase',
      queryTokens: ['needle'],
      fts,
    });

    expect(snippet).toContain('needle');
    expect(fts.tokenize).toHaveBeenCalledTimes(1);
    expect(fts.tokenize).toHaveBeenCalledWith('needle');
  });
});
