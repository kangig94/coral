import { readKnowledgeBaseListIndex } from '../../direct-read-index.js';
import { isWikiEntry, type KbWikiListItem, type WikiEntry } from '../../entry-types.js';
import { compareLocale } from '../../validation.js';
import type { KbRuntime } from '../../contract.js';

export async function listWikis(kb: KbRuntime): Promise<KbWikiListItem[]> {
  const index = readKnowledgeBaseListIndex(kb);
  const entries: WikiEntry[] = [];
  for (const entry of Object.values(index.entries)) {
    if (isWikiEntry(entry)) {
      entries.push(entry);
    }
  }
  entries.sort((left, right) => compareLocale(right.updatedAt, left.updatedAt) || compareLocale(left.slug, right.slug));

  const wikis: KbWikiListItem[] = [];
  for (const entry of entries) {
    wikis.push({
      slug: entry.slug,
      title: entry.title,
      tags: [...entry.tags],
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      knowledge: [...entry.knowledge],
    });
  }
  return wikis;
}
