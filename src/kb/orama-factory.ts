import { components, create, type AnyOrama, type DefaultTokenizer } from '@orama/orama';
import type { KbReindexNoteRecord } from './types.js';

const ORAMA_LANGUAGE = 'english';

export const ORAMA_SCHEMA = {
  slug: 'string',
  title: 'string',
  body: 'string',
  tags: 'string[]',
  principles: 'string[]',
} as const;

export type KbOramaDocument = {
  slug: string;
  title: string;
  body: string;
  tags: string[];
  principles: string[];
};

export type KbOramaDb = AnyOrama<typeof ORAMA_SCHEMA>;
export type KbOramaTokenizer = DefaultTokenizer;

export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function uniqueTokens(tokens: string[]): string[] {
  return [...new Set(tokens)];
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

  return uniqueTokens(tokenizer.tokenize(oramaTerm, ORAMA_LANGUAGE));
}

export function tokenizeField(value: string, tokenizer: KbOramaTokenizer): string[] {
  const normalized = normalizeOramaTerm(value);
  if (!normalized) {
    return [];
  }

  return uniqueTokens(tokenizer.tokenize(normalized, ORAMA_LANGUAGE));
}

export function toOramaDocument(note: KbReindexNoteRecord): KbOramaDocument {
  return {
    slug: normalizeHyphens(note.note),
    title: note.title,
    body: note.body,
    tags: note.tags.map(normalizeHyphens),
    principles: note.principles.map(normalizeHyphens),
  };
}

export async function createOramaDb(): Promise<{ db: KbOramaDb; tokenizer: KbOramaTokenizer }> {
  const tokenizer = components.tokenizer.createTokenizer({
    language: ORAMA_LANGUAGE,
    stemming: true,
  });
  const db = create({
    schema: ORAMA_SCHEMA,
    components: { tokenizer },
  });

  return {
    db: db as KbOramaDb,
    tokenizer,
  };
}
