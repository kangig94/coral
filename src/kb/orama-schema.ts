import type { AnyOrama, DefaultTokenizer } from '@orama/orama';

export const ORAMA_SCHEMA = {
  entryId: 'string',
  slug: 'string',
  kind: 'string',
  freshness: 'string',
  title: 'string',
  body: 'string',
  tags: 'string[]',
  principles: 'string[]',
} as const;

export type KbOramaDb = AnyOrama<typeof ORAMA_SCHEMA>;
export type KbOramaTokenizer = DefaultTokenizer;
