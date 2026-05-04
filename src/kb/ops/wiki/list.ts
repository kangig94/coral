import { readKnowledgeBaseListIndex } from '../../direct-read-index.js';
import { isWikiEntry, type KbWikiListItem } from '../../entry-types.js';
import { compareLocale } from '../../validation.js';
import type { KbRuntime } from '../../contract.js';

export async function listWikis(kb: KbRuntime): Promise<KbWikiListItem[]> {
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
