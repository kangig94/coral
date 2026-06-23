import type { AnyOrama, Tokenizer } from '@orama/orama';

export const ORAMA_SCHEMA = {
  entryId: 'string',
  slug: 'string',
  kind: 'string',
  freshness: 'string',
  title: 'string',
  body: 'string',
  tags: 'string[]',
  principles: 'string[]',
  slugSurface: 'string',
  titleSurface: 'string',
  bodySurface: 'string',
  tagsSurface: 'string',
  principlesSurface: 'string',
  slugNgram: 'string',
  titleNgram: 'string',
  bodyNgram: 'string',
  tagsNgram: 'string',
  principlesNgram: 'string',
  contentHash: 'string',
  metadataHash: 'string',
} as const;

export type KbOramaDb = AnyOrama<typeof ORAMA_SCHEMA>;
export type KbOramaTokenizer = Tokenizer;
