import { components, create, type AnyOrama, type DefaultTokenizer } from '@orama/orama';
import { noteEntryId, sourceEntryId, type KbReindexNoteRecord, type KbReindexSourceRecord } from './types.js';

const ORAMA_LANGUAGE = 'english';

export const ORAMA_SCHEMA = {
  entryId: 'string',
  slug: 'string',
  kind: 'string',
  title: 'string',
  body: 'string',
  tags: 'string[]',
  principles: 'string[]',
} as const;

export type KbOramaDocument = {
  entryId: string;
  slug: string;
  kind: 'note' | 'source';
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

export function toOramaDocument(record: KbReindexNoteRecord | KbReindexSourceRecord): KbOramaDocument {
  const isNote = 'note' in record;

  return {
    entryId: isNote ? noteEntryId(record.note) : sourceEntryId(record.slug),
    slug: normalizeHyphens(isNote ? record.note : record.slug),
    kind: isNote ? 'note' : 'source',
    title: record.title,
    body: record.body,
    tags: record.tags.map(normalizeHyphens),
    principles: isNote ? record.principles.map(normalizeHyphens) : [],
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
