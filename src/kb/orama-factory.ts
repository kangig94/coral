import { components, create, type AnyOrama, type DefaultTokenizer } from '@orama/orama';
import {
  communityEntryId,
  noteEntryId,
  sourceEntryId,
  type KbReindexCommunityRecord,
  type KbReindexNoteRecord,
  type KbReindexSourceRecord,
} from './types.js';

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
  kind: 'note' | 'source' | 'community';
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

export function toOramaDocument(
  record: KbReindexNoteRecord | KbReindexSourceRecord | KbReindexCommunityRecord,
): KbOramaDocument {
  if ('note' in record) {
    return {
      entryId: noteEntryId(record.note),
      slug: normalizeHyphens(record.note),
      kind: 'note',
      title: record.title,
      body: record.body,
      tags: record.tags.map(normalizeHyphens),
      principles: record.principles.map(normalizeHyphens),
    };
  }

  if ('type' in record) {
    return {
      entryId: sourceEntryId(record.slug),
      slug: normalizeHyphens(record.slug),
      kind: 'source',
      title: record.title,
      body: record.body,
      tags: record.tags.map(normalizeHyphens),
      principles: [],
    };
  }

  return {
    entryId: communityEntryId(record.slug),
    slug: normalizeHyphens(record.slug),
    kind: 'community',
    title: record.title,
    body: record.body,
    tags: record.members.map(normalizeHyphens),
    principles: [],
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
