import { describe, expect, it } from 'vitest';

import {
  createOramaTokenizer,
  normalizeOramaTerm,
  tokenizeQuery,
} from '#src/engines/orama/document-builder.js';

describe('orama multilingual tokenizer', () => {
  it('emits word tokens for Korean, Chinese, Japanese, and English input', () => {
    const tokenizer = createOramaTokenizer();

    expect(tokenizer.tokenize('한국어 검색 품질')).toEqual(['한국어', '검색', '품질']);
    expect(tokenizer.tokenize('中文搜索质量')).toEqual(['中文', '搜索', '质量']);
    expect(tokenizer.tokenize('日本語検索品質')).toEqual(['日本語', '検索', '品質']);
    expect(tokenizer.tokenize('English searching quality')).toEqual(['english', 'search', 'qualiti']);
  });

  it('uses the same tokenization path for index and query terms', () => {
    const tokenizer = createOramaTokenizer();
    const text = '검색 API cafés searching';

    expect(tokenizeQuery(normalizeOramaTerm(text), tokenizer)).toEqual(tokenizer.tokenize(normalizeOramaTerm(text)));
  });

  it('folds Latin diacritics without decomposing Hangul syllables', () => {
    const tokenizer = createOramaTokenizer();
    const tokens = tokenizer.tokenize('café 한글');

    expect(tokens).toContain('cafe');
    expect(tokens).toContain('한글');
    expect(tokens.some((token) => /[ᄀ-ᇿ]/u.test(token))).toBe(false);
  });

  it('ignores the Orama language argument instead of throwing', async () => {
    const tokenizer = createOramaTokenizer();

    await expect(Promise.resolve(tokenizer.tokenize('검색 language argument', 'korean'))).resolves.toContain('검색');
  });

  it('normalizes empty, hyphenated, and repeated query terms', () => {
    const tokenizer = createOramaTokenizer();

    expect(tokenizeQuery('', tokenizer)).toEqual([]);
    expect(normalizeOramaTerm('graph-rag')).toBe('graph rag');
    expect(tokenizeQuery(normalizeOramaTerm('graph graph graph'), tokenizer)).toEqual(['graph']);
  });
});
