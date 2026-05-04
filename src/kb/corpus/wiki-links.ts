import { vaultLinkToEntryId, type KbEntryId } from '../entry-types.js';

/**
 * Canonical Knowledge section wikilink extractor — restrictive prefix-anchored
 * pattern is correct per plan AC4. Only matches `[[notes/...]]`, `[[sources/...]]`,
 * `[[communities/...]]`, and `[[wiki/...]]` shapes; any other bracket sequence
 * inside a Knowledge section is ignored rather than treated as a knowledge link.
 */
export const KNOWLEDGE_WIKILINK_PATTERN = /\[\[(?:notes|sources|communities|wiki)\/[^[\]/]+\]\]/g;

/**
 * Extract deduplicated KB entry IDs from the Knowledge section body of a wiki.
 * Non-knowledge wikilinks are skipped silently — the restrictive regex above
 * never matches them, and `vaultLinkToEntryId` returning `null` (e.g. invalid
 * slug) is treated as a skip rather than an error.
 */
export function extractKnowledgeLinks(body: string): KbEntryId[] {
  const links: KbEntryId[] = [];
  const seen = new Set<KbEntryId>();

  for (const match of body.matchAll(KNOWLEDGE_WIKILINK_PATTERN)) {
    const entryId = vaultLinkToEntryId(match[0]);
    if (entryId === null || seen.has(entryId)) {
      continue;
    }
    seen.add(entryId);
    links.push(entryId);
  }

  return links;
}
