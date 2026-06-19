import { create } from '@orama/orama';
import {
  computeContentSurfaceHash,
  computeMetadataSurfaceHash,
  type CanonicalFrontmatterRecord,
} from '../../kb/corpus/snapshot.js';
import {
  communityEntryId,
  noteEntryId,
  sourceEntryId,
  wikiEntryId,
  type KbReindexCommunityRecord,
  type KbReindexNoteRecord,
  type KbReindexSourceRecord,
  type WikiEntry,
} from '../../kb/entry-types.js';
import { ORAMA_SCHEMA, type KbOramaDb, type KbOramaTokenizer } from './schema.js';
import { normalizeWhitespace } from '../../kb/text-normalization.js';

const TOKENIZER_LANGUAGE = 'multilingual';
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' });
const LATIN_SCRIPT_PATTERN = /\p{Script=Latin}/u;
const HANGUL_SCRIPT_PATTERN = /\p{Script=Hangul}/u;
const TOKEN_SCRIPT_RUN_PATTERN = /\p{Script=Hangul}[\p{Script=Hangul}\p{M}\p{N}_'-]*|[^\p{Script=Hangul}\s]+/gu;
const COMBINING_MARK_PATTERN = /\p{M}/u;
const COMBINING_MARKS_PATTERN = /\p{M}/gu;
const ASCII_ALPHA_PATTERN = /^[a-z]+$/;

export type KbOramaDocument = {
  id: string;
  entryId: string;
  slug: string;
  kind: 'note' | 'source' | 'community' | 'wiki';
  freshness: 'fresh' | 'stale';
  title: string;
  body: string;
  tags: string[];
  principles: string[];
  contentHash: string;
  metadataHash: string;
};

type KbReindexWikiRecord = Omit<WikiEntry, 'kind'> & {
  path: string;
  body: string;
};

export type OramaTokenizerAnalyzer = {
  tokens(raw: string): readonly string[];
};

export type CreateOramaTokenizerOptions = {
  readonly currentKiwiAnalyzer?: () => OramaTokenizerAnalyzer | null;
};

function foldLatinRun(raw: string): string {
  return raw.normalize('NFD').replace(COMBINING_MARKS_PATTERN, '');
}

// Strip combining marks only from Latin runs; global NFD stripping decomposes Hangul syllables into jamo.
function foldLatinDiacritics(raw: string): string {
  let folded = '';
  let latinRun = '';

  for (const char of raw) {
    if (LATIN_SCRIPT_PATTERN.test(char)) {
      latinRun += char;
      continue;
    }

    if (latinRun && COMBINING_MARK_PATTERN.test(char)) {
      latinRun += char;
      continue;
    }

    if (latinRun) {
      folded += foldLatinRun(latinRun);
      latinRun = '';
    }
    folded += char;
  }

  if (latinRun) {
    folded += foldLatinRun(latinRun);
  }

  return folded;
}

// Local Porter stemmer keeps the tokenizer independent from Orama private helpers.
function isAsciiConsonant(word: string, index: number): boolean {
  const char = word[index];
  if (char === 'a' || char === 'e' || char === 'i' || char === 'o' || char === 'u') {
    return false;
  }
  if (char === 'y') {
    return index === 0 ? true : !isAsciiConsonant(word, index - 1);
  }
  return true;
}

function asciiMeasure(word: string): number {
  let measure = 0;
  let sawVowel = false;

  for (let index = 0; index < word.length; index += 1) {
    if (isAsciiConsonant(word, index)) {
      if (sawVowel) {
        measure += 1;
        sawVowel = false;
      }
      continue;
    }
    sawVowel = true;
  }

  return measure;
}

function containsAsciiVowel(word: string): boolean {
  for (let index = 0; index < word.length; index += 1) {
    if (!isAsciiConsonant(word, index)) {
      return true;
    }
  }
  return false;
}

function endsWithDoubleAsciiConsonant(word: string): boolean {
  const last = word.length - 1;
  if (last < 1 || word[last] !== word[last - 1]) {
    return false;
  }
  return isAsciiConsonant(word, last);
}

function isAsciiCvc(word: string): boolean {
  const last = word.length - 1;
  if (last < 2) {
    return false;
  }

  const finalChar = word[last];
  return (
    isAsciiConsonant(word, last) &&
    !isAsciiConsonant(word, last - 1) &&
    isAsciiConsonant(word, last - 2) &&
    finalChar !== 'w' &&
    finalChar !== 'x' &&
    finalChar !== 'y'
  );
}

function replaceSuffixByMeasure(
  word: string,
  suffix: string,
  replacement: string,
  minMeasureExclusive: number,
): string | null {
  if (!word.endsWith(suffix)) {
    return null;
  }

  const stem = word.slice(0, -suffix.length);
  if (asciiMeasure(stem) <= minMeasureExclusive) {
    return null;
  }

  return `${stem}${replacement}`;
}

function porterStep1a(word: string): string {
  if (word.endsWith('sses')) {
    return word.slice(0, -2);
  }
  if (word.endsWith('ies')) {
    return word.slice(0, -2);
  }
  if (word.endsWith('ss')) {
    return word;
  }
  if (word.endsWith('s')) {
    return word.slice(0, -1);
  }
  return word;
}

function porterStep1b(word: string): string {
  const eedReplacement = replaceSuffixByMeasure(word, 'eed', 'ee', 0);
  if (eedReplacement !== null) {
    return eedReplacement;
  }
  if (word.endsWith('eed')) {
    return word;
  }

  for (const suffix of ['ed', 'ing'] as const) {
    if (!word.endsWith(suffix)) {
      continue;
    }

    let stem = word.slice(0, -suffix.length);
    if (!containsAsciiVowel(stem)) {
      return word;
    }

    if (stem.endsWith('at') || stem.endsWith('bl') || stem.endsWith('iz')) {
      stem += 'e';
    } else if (endsWithDoubleAsciiConsonant(stem)) {
      const finalChar = stem[stem.length - 1];
      if (finalChar !== 'l' && finalChar !== 's' && finalChar !== 'z') {
        stem = stem.slice(0, -1);
      }
    } else if (asciiMeasure(stem) === 1 && isAsciiCvc(stem)) {
      stem += 'e';
    }

    return stem;
  }

  return word;
}

function porterStep1c(word: string): string {
  if (!word.endsWith('y')) {
    return word;
  }

  const stem = word.slice(0, -1);
  return containsAsciiVowel(stem) ? `${stem}i` : word;
}

const PORTER_STEP2_SUFFIXES: ReadonlyArray<readonly [suffix: string, replacement: string]> = [
  ['ization', 'ize'],
  ['ational', 'ate'],
  ['fulness', 'ful'],
  ['ousness', 'ous'],
  ['iveness', 'ive'],
  ['tional', 'tion'],
  ['biliti', 'ble'],
  ['alism', 'al'],
  ['ation', 'ate'],
  ['ator', 'ate'],
  ['aliti', 'al'],
  ['iviti', 'ive'],
  ['enci', 'ence'],
  ['anci', 'ance'],
  ['izer', 'ize'],
  ['alli', 'al'],
  ['entli', 'ent'],
  ['ousli', 'ous'],
  ['bli', 'ble'],
  ['eli', 'e'],
  ['logi', 'log'],
];

const PORTER_STEP3_SUFFIXES: ReadonlyArray<readonly [suffix: string, replacement: string]> = [
  ['icate', 'ic'],
  ['ative', ''],
  ['alize', 'al'],
  ['iciti', 'ic'],
  ['ical', 'ic'],
  ['ful', ''],
  ['ness', ''],
];

const PORTER_STEP4_SUFFIXES = [
  'ement',
  'ance',
  'ence',
  'able',
  'ible',
  'ment',
  'ant',
  'ent',
  'ism',
  'ate',
  'iti',
  'ous',
  'ive',
  'ize',
  'al',
  'er',
  'ic',
  'ou',
] as const;

function applyPorterSuffixes(
  word: string,
  suffixes: ReadonlyArray<readonly [suffix: string, replacement: string]>,
): string {
  for (const [suffix, replacement] of suffixes) {
    const replaced = replaceSuffixByMeasure(word, suffix, replacement, 0);
    if (replaced !== null) {
      return replaced;
    }
  }
  return word;
}

function porterStep4(word: string): string {
  if (word.endsWith('ion')) {
    const stem = word.slice(0, -3);
    if (asciiMeasure(stem) > 1 && (stem.endsWith('s') || stem.endsWith('t'))) {
      return stem;
    }
    return word;
  }

  for (const suffix of PORTER_STEP4_SUFFIXES) {
    const replaced = replaceSuffixByMeasure(word, suffix, '', 1);
    if (replaced !== null) {
      return replaced;
    }
  }

  return word;
}

function porterStep5a(word: string): string {
  if (!word.endsWith('e')) {
    return word;
  }

  const stem = word.slice(0, -1);
  const measure = asciiMeasure(stem);
  if (measure > 1 || (measure === 1 && !isAsciiCvc(stem))) {
    return stem;
  }
  return word;
}

function porterStep5b(word: string): string {
  if (asciiMeasure(word) > 1 && endsWithDoubleAsciiConsonant(word) && word.endsWith('l')) {
    return word.slice(0, -1);
  }
  return word;
}

function porterStemAscii(word: string): string {
  if (word.length < 3) {
    return word;
  }

  let stem = porterStep1a(word);
  stem = porterStep1b(stem);
  stem = porterStep1c(stem);
  stem = applyPorterSuffixes(stem, PORTER_STEP2_SUFFIXES);
  stem = applyPorterSuffixes(stem, PORTER_STEP3_SUFFIXES);
  stem = porterStep4(stem);
  stem = porterStep5a(stem);
  stem = porterStep5b(stem);
  return stem;
}

function normalizeToken(token: string, normalizationCache: Map<string, string>, withCache: boolean): string {
  if (withCache) {
    const cached = normalizationCache.get(token);
    if (cached !== undefined) {
      return cached;
    }
  }

  let normalized = foldLatinDiacritics(token);
  if (ASCII_ALPHA_PATTERN.test(normalized)) {
    normalized = porterStemAscii(normalized);
  }

  if (withCache) {
    normalizationCache.set(token, normalized);
  }

  return normalized;
}

function tokenizeIntlWords(raw: string, normalizationCache: Map<string, string>, withCache: boolean): string[] {
  const tokens: string[] = [];
  for (const segment of WORD_SEGMENTER.segment(raw.toLowerCase())) {
    if (segment.isWordLike !== true) {
      continue;
    }

    const normalized = normalizeToken(segment.segment, normalizationCache, withCache);
    if (normalized) {
      tokens.push(normalized);
    }
  }

  return tokens;
}

function tokenizeKiwiHangulRun(
  raw: string,
  analyzer: OramaTokenizerAnalyzer,
  normalizationCache: Map<string, string>,
  withCache: boolean,
): string[] {
  const tokens: string[] = [];
  for (const token of analyzer.tokens(raw)) {
    const normalized = normalizeToken(token.toLowerCase(), normalizationCache, withCache);
    if (normalized) {
      tokens.push(normalized);
    }
  }
  return tokens;
}

function tokenizeScriptRuns(
  raw: string,
  normalizationCache: Map<string, string>,
  withCache: boolean,
  currentKiwiAnalyzer: () => OramaTokenizerAnalyzer | null,
): string[] {
  const tokens: string[] = [];
  const analyzer = currentKiwiAnalyzer();
  for (const run of raw.matchAll(TOKEN_SCRIPT_RUN_PATTERN)) {
    const value = run[0];
    if (HANGUL_SCRIPT_PATTERN.test(value) && analyzer !== null) {
      tokens.push(...tokenizeKiwiHangulRun(value, analyzer, normalizationCache, withCache));
      continue;
    }
    tokens.push(...tokenizeIntlWords(value, normalizationCache, withCache));
  }

  return uniqueTokens(tokens);
}

function uniqueTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    unique.push(token);
  }
  return unique;
}

export function normalizeHyphens(raw: string): string {
  return raw.replace(/-/g, ' ');
}

export function normalizeOramaTerm(raw: string): string {
  return normalizeWhitespace(normalizeHyphens(raw));
}

export function tokenizeQuery(oramaTerm: string, tokenizer: KbOramaTokenizer): string[] {
  if (!oramaTerm) {
    return [];
  }

  return uniqueTokens(tokenizer.tokenize(oramaTerm));
}

export function toOramaDocument(
  record: KbReindexNoteRecord | KbReindexSourceRecord | KbReindexCommunityRecord | KbReindexWikiRecord,
  options: {
    communityFresh?: boolean;
    contentHash?: string;
    metadataHash?: string;
  } = {},
): KbOramaDocument {
  if ('note' in record) {
    const entryId = noteEntryId(record.note);
    return {
      id: entryId,
      entryId,
      slug: normalizeHyphens(record.note),
      kind: 'note',
      freshness: 'fresh',
      title: record.title,
      body: record.body,
      tags: record.tags.map(normalizeHyphens),
      principles: record.principles.map(normalizeHyphens),
      contentHash:
        options.contentHash ??
        computeContentSurfaceHash({
          title: record.title,
          body: record.body,
        }),
      metadataHash:
        options.metadataHash ??
        computeMetadataSurfaceHash({
          frontmatter: {
            tags: record.tags,
            principles: record.principles,
            source: record.source,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            inputFingerprint: record.inputFingerprint,
            entrySeq: record.entrySeq,
            related: record.related,
          } as CanonicalFrontmatterRecord,
        }),
    };
  }

  if ('type' in record) {
    const entryId = sourceEntryId(record.slug);
    return {
      id: entryId,
      entryId,
      slug: normalizeHyphens(record.slug),
      kind: 'source',
      freshness: 'fresh',
      title: record.title,
      body: record.body,
      tags: record.tags.map(normalizeHyphens),
      principles: [],
      contentHash:
        options.contentHash ??
        computeContentSurfaceHash({
          title: record.title,
          body: record.body,
        }),
      metadataHash:
        options.metadataHash ??
        computeMetadataSurfaceHash({
          frontmatter: {
            type: record.type,
            tags: record.tags,
            url: record.url,
            importedAt: record.importedAt,
            inputFingerprint: record.inputFingerprint,
            entrySeq: record.entrySeq,
            related: record.related,
          } as CanonicalFrontmatterRecord,
        }),
    };
  }

  if ('knowledge' in record) {
    const entryId = wikiEntryId(record.slug);
    return {
      id: entryId,
      entryId,
      slug: normalizeHyphens(record.slug),
      kind: 'wiki',
      freshness: 'fresh',
      title: record.title,
      body: record.body,
      tags: record.tags.map(normalizeHyphens),
      principles: [],
      contentHash:
        options.contentHash ??
        computeContentSurfaceHash({
          title: record.title,
          body: record.body,
        }),
      metadataHash:
        options.metadataHash ??
        computeMetadataSurfaceHash({
          frontmatter: {
            tags: record.tags,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          } as CanonicalFrontmatterRecord,
        }),
    };
  }

  const entryId = communityEntryId(record.slug);
  return {
    id: entryId,
    entryId,
    slug: normalizeHyphens(record.slug),
    kind: 'community',
    freshness: options.communityFresh === false ? 'stale' : 'fresh',
    title: record.title,
    body: record.body,
    tags: record.members.map(normalizeHyphens),
    principles: [],
    contentHash:
      options.contentHash ??
      computeContentSurfaceHash({
        title: record.title,
        body: record.body,
      }),
    metadataHash:
      options.metadataHash ??
      computeMetadataSurfaceHash({
        frontmatter: {
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          level: record.level,
          parent: record.parent,
          children: record.children,
          members: record.members,
          summary: record.summary,
        } as CanonicalFrontmatterRecord,
      }),
  };
}

export function createOramaTokenizer(options: CreateOramaTokenizerOptions = {}): KbOramaTokenizer {
  const normalizationCache = new Map<string, string>();
  const getCurrentKiwiAnalyzer = options.currentKiwiAnalyzer ?? (() => null);
  return {
    language: TOKENIZER_LANGUAGE,
    normalizationCache,
    tokenize(raw, _language, _prop, withCache = true) {
      return tokenizeScriptRuns(raw, normalizationCache, withCache, getCurrentKiwiAnalyzer);
    },
  };
}

export async function createOramaDb(
  options: CreateOramaTokenizerOptions = {},
): Promise<{ db: KbOramaDb; tokenizer: KbOramaTokenizer }> {
  const tokenizer = createOramaTokenizer(options);
  const db = create({
    schema: ORAMA_SCHEMA,
    components: { tokenizer },
  });

  return {
    db: db as KbOramaDb,
    tokenizer,
  };
}
