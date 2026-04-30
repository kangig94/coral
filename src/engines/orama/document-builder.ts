import { components, create } from '@orama/orama';
import {
  computeContentSurfaceHash,
  computeMetadataSurfaceHash,
  type CanonicalFrontmatterRecord,
} from '../../kb/corpus/snapshot.js';
import {
  communityEntryId,
  noteEntryId,
  sourceEntryId,
  type KbReindexCommunityRecord,
  type KbReindexNoteRecord,
  type KbReindexSourceRecord,
} from '../../kb/entry-types.js';
import { ORAMA_SCHEMA, type KbOramaDb, type KbOramaTokenizer } from './schema.js';

const ORAMA_LANGUAGE = 'english';

export type KbOramaDocument = {
  id: string;
  entryId: string;
  slug: string;
  kind: 'note' | 'source' | 'community';
  freshness: 'fresh' | 'stale';
  title: string;
  body: string;
  tags: string[];
  principles: string[];
  contentHash: string;
  metadataHash: string;
};

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

export function toOramaDocument(
  record: KbReindexNoteRecord | KbReindexSourceRecord | KbReindexCommunityRecord,
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
            entrySeq: record.entrySeq,
            related: record.related,
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

export function createOramaTokenizer(): KbOramaTokenizer {
  return components.tokenizer.createTokenizer({
    language: ORAMA_LANGUAGE,
    stemming: true,
  });
}

export async function createOramaDb(): Promise<{ db: KbOramaDb; tokenizer: KbOramaTokenizer }> {
  const tokenizer = createOramaTokenizer();
  const db = create({
    schema: ORAMA_SCHEMA,
    components: { tokenizer },
  });

  return {
    db: db as KbOramaDb,
    tokenizer,
  };
}
