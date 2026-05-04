import { readKnowledgeBaseListIndex } from '../../direct-read-index.js';
import { isWikiEntry, type KbEntryId, type KbWikiFrontmatter } from '../../entry-types.js';
import { compareLocale } from '../../validation.js';
import type { KbRuntime } from '../../contract.js';

export type WikiListItem = KbWikiFrontmatter & {
  slug: string;
  title: string;
  knowledge: KbEntryId[];
};

export async function listWikis(kb: KbRuntime): Promise<WikiListItem[]> {
  const index = readKnowledgeBaseListIndex(kb);
  return Object.values(index.entries)
    .filter(isWikiEntry)
    .sort((left, right) => compareLocale(right.updatedAt, left.updatedAt) || compareLocale(left.slug, right.slug))
    .map((entry) => ({
      slug: entry.slug,
      title: entry.title,
      tags: [...entry.tags],
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      knowledge: [...entry.knowledge],
    }));
}
