import { vaultLinkToEntryId, type KbEntryId } from '../entry-types.js';

/** Top-level Knowledge entry line: `- [[link]]` at column 0. */
const KNOWLEDGE_TOP_LEVEL_LINE = /^-\s+(\[\[(?:notes|sources|communities|wiki)\/[^[\]/]+\]\])\s*$/;

/**
 * Extract deduplicated KB entry IDs from a wiki Knowledge section, considering
 * only top-level `- [[link]]` lines. Indented sub-bullet evidence lines may
 * themselves contain wikilinks (e.g. cross-references inside an evidence note),
 * but those do not count as Knowledge entries.
 */
export function extractKnowledgeLinks(body: string): KbEntryId[] {
  const links: KbEntryId[] = [];
  const seen = new Set<KbEntryId>();

  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+$/u, '');
    const match = line.match(KNOWLEDGE_TOP_LEVEL_LINE);
    if (match === null) {
      continue;
    }
    const entryId = vaultLinkToEntryId(match[1]);
    if (entryId === null || seen.has(entryId)) {
      continue;
    }
    seen.add(entryId);
    links.push(entryId);
  }

  return links;
}
