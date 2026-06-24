const SEARCH_TERM_PATTERN = /[\p{Letter}\p{Number}][\p{Letter}\p{Number}\p{Mark}_'-]*/gu;
const LATIN_SCRIPT_PATTERN = /\p{Script=Latin}/u;
const COMBINING_MARK_PATTERN = /\p{M}/u;
const COMBINING_MARKS_PATTERN = /\p{M}/gu;
const HANGUL_CHAR_PATTERN = /\p{Script=Hangul}/u;
const HANGUL_ONLY_PATTERN = /[^\p{Script=Hangul}]+/gu;
const WORD_BOUNDARY_PATTERN = /[\s_-]+/g;
const CAMEL_BOUNDARY_PATTERN = /([\p{Ll}\p{Nd}])([\p{Lu}])/gu;
const LETTER_NUMBER_BOUNDARY_PATTERN = /([\p{L}])([\p{N}])/gu;
const NUMBER_LETTER_BOUNDARY_PATTERN = /([\p{N}])([\p{L}])/gu;

export const ORAMA_BODY_SURFACE_TERM_LIMIT = 2_048;
export const ORAMA_BODY_NGRAM_SOURCE_CHAR_LIMIT = 4_096;
export const ORAMA_BODY_NGRAM_TERM_LIMIT = 4_096;

export const ORAMA_SEARCH_FIELDS = ['slug', 'title', 'body', 'tags', 'principles'] as const;
export type OramaSearchField = (typeof ORAMA_SEARCH_FIELDS)[number];
export type OramaSearchChannel = 'morph' | 'surface' | 'ngram';

export type OramaSearchChannelFields = {
  slugSurface: string;
  titleSurface: string;
  bodySurface: string;
  tagsSurface: string;
  principlesSurface: string;
  slugNgram: string;
  titleNgram: string;
  bodyNgram: string;
  tagsNgram: string;
  principlesNgram: string;
};

export type OramaSearchProperty = OramaSearchField | keyof OramaSearchChannelFields;

export type OramaSearchQueryAnalysis = {
  readonly morph: readonly string[];
  readonly surface: readonly string[];
  readonly ngram: readonly string[];
  readonly phrases: readonly string[];
  readonly fuzzy: readonly string[];
};

export const ORAMA_SEARCH_CHANNEL_PROPERTIES = {
  morph: ORAMA_SEARCH_FIELDS,
  surface: ['slugSurface', 'titleSurface', 'bodySurface', 'tagsSurface', 'principlesSurface'],
  ngram: ['slugNgram', 'titleNgram', 'bodyNgram', 'tagsNgram', 'principlesNgram'],
} as const satisfies Record<OramaSearchChannel, readonly OramaSearchProperty[]>;

export const ORAMA_SEARCH_CHANNEL_BOOST = {
  morph: {
    slug: 3,
    title: 2,
    tags: 1.5,
    principles: 1.5,
    body: 1,
  },
  surface: {
    slugSurface: 2.4,
    titleSurface: 1.8,
    tagsSurface: 1.4,
    principlesSurface: 1.4,
    bodySurface: 0.8,
  },
  ngram: {
    slugNgram: 1.2,
    titleNgram: 1,
    tagsNgram: 0.8,
    principlesNgram: 0.8,
    bodyNgram: 0.5,
  },
} as const satisfies Record<OramaSearchChannel, Partial<Record<OramaSearchProperty, number>>>;

export const ORAMA_SEARCH_CHANNEL_WEIGHT: Record<OramaSearchChannel, number> = {
  morph: 1,
  surface: 0.72,
  ngram: 0.34,
};

export const ORAMA_SEARCH_RRF_K = 60;
export const ORAMA_SEARCH_FUZZY_MULTIPLIER = 0.2;

export const ORAMA_FIELD_PRIORITY: Record<OramaSearchField, number> = {
  slug: 5,
  title: 4,
  tags: 3,
  principles: 3,
  body: 1,
};

export const ORAMA_FIELD_EXACT_BOOST: Record<OramaSearchField, number> = {
  slug: 12,
  title: 10,
  tags: 8,
  principles: 8,
  body: 3,
};

export const ORAMA_FIELD_PHRASE_BOOST: Record<OramaSearchField, number> = {
  slug: 7,
  title: 6,
  tags: 5,
  principles: 5,
  body: 2,
};

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
      folded += latinRun.normalize('NFD').replace(COMBINING_MARKS_PATTERN, '');
      latinRun = '';
    }
    folded += char;
  }

  if (latinRun) {
    folded += latinRun.normalize('NFD').replace(COMBINING_MARKS_PATTERN, '');
  }

  return folded;
}

function pushUniqueTerm(term: string, seen: Set<string>, unique: string[], maxTerms?: number): boolean {
  if (maxTerms !== undefined && unique.length >= maxTerms) {
    return true;
  }
  if (!term || seen.has(term)) {
    return false;
  }
  seen.add(term);
  unique.push(term);
  return maxTerms !== undefined && unique.length >= maxTerms;
}

function uniqueTerms(terms: Iterable<string>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const term of terms) {
    pushUniqueTerm(term, seen, unique);
  }
  return unique;
}

function normalizeSurfaceTerm(raw: string): string {
  return foldLatinDiacritics(raw).normalize('NFKC').toLowerCase();
}

function isUsefulExpandedSurfaceTerm(term: string): boolean {
  return HANGUL_CHAR_PATTERN.test(term) || [...term].length >= 2;
}

function splitCompoundTerm(raw: string): string[] {
  return raw
    .replace(CAMEL_BOUNDARY_PATTERN, '$1 $2')
    .replace(LETTER_NUMBER_BOUNDARY_PATTERN, '$1 $2')
    .replace(NUMBER_LETTER_BOUNDARY_PATTERN, '$1 $2')
    .replace(WORD_BOUNDARY_PATTERN, ' ')
    .split(' ')
    .map((part) => normalizeSurfaceTerm(part))
    .filter(isUsefulExpandedSurfaceTerm);
}

export function surfaceSearchTerms(raw: string, options: { maxTerms?: number } = {}): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const match of raw.matchAll(SEARCH_TERM_PATTERN)) {
    const compact = normalizeSurfaceTerm(match[0]);
    if (pushUniqueTerm(compact, seen, terms, options.maxTerms)) {
      return terms;
    }
    for (const part of splitCompoundTerm(match[0])) {
      if (pushUniqueTerm(part, seen, terms, options.maxTerms)) {
        return terms;
      }
    }
  }
  return terms;
}

function hangulCompact(raw: string): string {
  return raw.replace(HANGUL_ONLY_PATTERN, '');
}

function takeCodePoints(raw: string, limit: number | undefined): string {
  if (limit === undefined) {
    return raw;
  }
  return [...raw].slice(0, limit).join('');
}

function* characterNgrams(raw: string, min: number, max: number): Iterable<string> {
  const chars = [...raw];
  for (let size = min; size <= max; size += 1) {
    if (chars.length < size) {
      continue;
    }
    for (let index = 0; index <= chars.length - size; index += 1) {
      yield chars.slice(index, index + size).join('');
    }
  }
}

export function ngramSearchTerms(
  raw: string,
  options: { maxTerms?: number; maxSourceChars?: number; surfaceTermLimit?: number } = {},
): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const append = (term: string): boolean => pushUniqueTerm(term, seen, terms, options.maxTerms);
  // Generate n-grams lazily so long bodies cannot allocate the full n-gram set
  // before the caller's term cap has a chance to stop indexing.
  for (const term of surfaceSearchTerms(raw, { maxTerms: options.surfaceTermLimit })) {
    if (HANGUL_CHAR_PATTERN.test(term)) {
      const compactTerm = takeCodePoints(hangulCompact(term), options.maxSourceChars);
      for (const ngram of characterNgrams(compactTerm, 2, 3)) {
        if (append(ngram)) {
          return terms;
        }
      }
    }
  }

  const compactHangul = takeCodePoints(hangulCompact(raw), options.maxSourceChars);
  if (compactHangul.length >= 2) {
    for (const ngram of characterNgrams(compactHangul, 2, 3)) {
      if (append(ngram)) {
        return terms;
      }
    }
  }

  return terms;
}

function fieldText(raw: string | readonly string[]): string {
  return typeof raw === 'string' ? raw : raw.join(' ');
}

function termsText(terms: readonly string[]): string {
  return terms.join(' ');
}

export function buildOramaSearchChannelFields(
  fields: Record<OramaSearchField, string | readonly string[]>,
): OramaSearchChannelFields {
  const slug = fieldText(fields.slug);
  const title = fieldText(fields.title);
  const body = fieldText(fields.body);
  const tags = fieldText(fields.tags);
  const principles = fieldText(fields.principles);

  return {
    slugSurface: termsText(surfaceSearchTerms(slug)),
    titleSurface: termsText(surfaceSearchTerms(title)),
    bodySurface: termsText(surfaceSearchTerms(body, { maxTerms: ORAMA_BODY_SURFACE_TERM_LIMIT })),
    tagsSurface: termsText(surfaceSearchTerms(tags)),
    principlesSurface: termsText(surfaceSearchTerms(principles)),
    slugNgram: termsText(ngramSearchTerms(slug)),
    titleNgram: termsText(ngramSearchTerms(title)),
    bodyNgram: termsText(
      ngramSearchTerms(body, {
        maxTerms: ORAMA_BODY_NGRAM_TERM_LIMIT,
        maxSourceChars: ORAMA_BODY_NGRAM_SOURCE_CHAR_LIMIT,
        surfaceTermLimit: ORAMA_BODY_SURFACE_TERM_LIMIT,
      }),
    ),
    tagsNgram: termsText(ngramSearchTerms(tags)),
    principlesNgram: termsText(ngramSearchTerms(principles)),
  };
}

export function analyzeOramaSearchQuery(raw: string, morphTerms: readonly string[]): OramaSearchQueryAnalysis {
  const surface = surfaceSearchTerms(raw);
  const ngram = ngramSearchTerms(raw);
  const normalizedRaw = normalizeSurfaceTerm(raw).replace(WORD_BOUNDARY_PATTERN, ' ').trim();
  const phrases = uniqueTerms([normalizedRaw, surface.join(' '), surface.join('')]);
  const fuzzyCandidates = uniqueTerms([...morphTerms, ...surface]);
  const fuzzy =
    fuzzyCandidates.length > 0 && fuzzyCandidates.every((term) => /^[a-z0-9]{5,}$/u.test(term)) ? fuzzyCandidates : [];
  return {
    morph: uniqueTerms(morphTerms),
    surface,
    ngram,
    phrases,
    fuzzy,
  };
}

export function normalizedIdentityText(raw: string | readonly string[]): string {
  return surfaceSearchTerms(fieldText(raw)).join(' ');
}

export function normalizedCompactIdentityText(raw: string | readonly string[]): string {
  return surfaceSearchTerms(fieldText(raw)).join('');
}
