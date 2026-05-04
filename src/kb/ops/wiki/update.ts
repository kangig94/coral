import { nowIsoString } from '../../../infra/time.js';
import { captureWikiManifestDeltas } from '../../corpus/manifest-authority.js';
import {
  extractBody,
  extractTitle,
  parseWikiBody,
  parseWikiFrontmatter,
  serializeWiki,
} from '../../corpus/frontmatter.js';
import { commitCorpusEntryLocked } from '../../corpus/index-mutations.js';
import { buildWikiIndexEntry } from '../../corpus/index-records.js';
import { extractKnowledgeLinks } from '../../corpus/wiki-links.js';
import { syncEvidenceForRemovedKnowledge } from './rewrite.js';
import {
  entryIdToVaultLink,
  parseKbEntryId,
  setEntry,
  vaultLinkToEntryId,
  wikiEntryId,
  type KbEntryId,
  type KbWikiFrontmatter,
} from '../../entry-types.js';
import { assertNonEmptyText, assertString, assertWikiSlug } from '../../validation.js';
import type { KbIndexMutationLane, KbMutationEffects, KbRuntime } from '../../contract.js';

export type WikiTextOrFile = string | { text: string } | { file: string };

/**
 * Accepts both snake_case (wire format) and camelCase (TS convenience) for
 * `evidence_append` / `evidenceAppend`, `knowledge_reorder` / `knowledgeReorder`,
 * `knowledge_add` / `knowledgeAdd`, `knowledge_remove` / `knowledgeRemove`, and
 * `references_principles` / `referencesPrinciples`.
 */
export type KbWikiUpdateInput = {
  slug: string;
  understanding?: WikiTextOrFile;
  evidenceAppend?: WikiTextOrFile;
  evidence_append?: WikiTextOrFile;
  knowledgeReorder?: string | readonly string[];
  knowledge_reorder?: string | readonly string[];
  knowledgeAdd?: string | readonly string[];
  knowledge_add?: string | readonly string[];
  knowledgeRemove?: string | readonly string[];
  knowledge_remove?: string | readonly string[];
  tags?: readonly string[];
  references_principles?: readonly string[];
  referencesPrinciples?: readonly string[];
  related?: readonly string[];
  updatedAt?: string;
};

export type KbWikiUpdateResponse = {
  path: string;
};

type WikiSections = {
  understanding: string;
  knowledge: string;
  evidence: string;
};

// Permissive pattern used only by `tokenizeLinkList` to find candidate wikilinks
// inside CLI-provided link-list arguments. Knowledge-section parsing uses the
// canonical restrictive helper from `corpus/wiki-links.js`.
const LINK_LIST_TOKEN_PATTERN = /\[\[[^\]\r\n]+\]\]/g;

function normalizeStringList(values: readonly string[], field: string): string[] {
  return values.map((value) => assertNonEmptyText(value, field));
}

function normalizeEntryReference(value: string, field: string): KbEntryId {
  const trimmed = assertNonEmptyText(value, field);
  const entryId = parseKbEntryId(trimmed) ?? vaultLinkToEntryId(trimmed);
  if (entryId === null) {
    throw new Error(`${field} must be a KB entry ID or vault-relative wikilink`);
  }
  return entryId;
}

function normalizeEntryReferences(values: readonly string[], field: string): KbEntryId[] {
  return values.map((value) => normalizeEntryReference(value, field));
}

function uniqueEntries(entries: readonly KbEntryId[]): KbEntryId[] {
  const seen = new Set<KbEntryId>();
  const unique: KbEntryId[] = [];
  for (const entry of entries) {
    if (!seen.has(entry)) {
      seen.add(entry);
      unique.push(entry);
    }
  }
  return unique;
}

function tokenizeLinkList(value: string): string[] {
  const tokens: string[] = [];
  let cursor = 0;

  for (const match of value.matchAll(LINK_LIST_TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    tokens.push(
      ...value
        .slice(cursor, index)
        .split(/[\s,]+/)
        .filter(Boolean),
    );
    tokens.push(match[0]);
    cursor = index + match[0].length;
  }

  tokens.push(
    ...value
      .slice(cursor)
      .split(/[\s,]+/)
      .filter(Boolean),
  );
  return tokens;
}

function parseLinkList(value: string | readonly string[], field: string): KbEntryId[] {
  const rawLinks = typeof value === 'string' ? tokenizeLinkList(assertNonEmptyText(value, field)) : value;
  return uniqueEntries(rawLinks.map((link) => normalizeEntryReference(link, field)));
}

function sameOrderedEntries(left: readonly KbEntryId[], right: readonly KbEntryId[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sameEntrySet(left: readonly KbEntryId[], right: readonly KbEntryId[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const rightSet = new Set(right);
  return left.every((entry) => rightSet.has(entry));
}

function formatKnowledgeLinks(links: readonly KbEntryId[]): string {
  return links.map((link) => `- ${entryIdToVaultLink(link)}`).join('\n');
}

function buildWikiBody(sections: WikiSections): string {
  return `## Understanding

${sections.understanding.trim()}

## Knowledge

${sections.knowledge.trim()}

## Evidence

${sections.evidence.trim()}`;
}

function resolveTextOrFile(rt: KbRuntime, value: WikiTextOrFile, field: string): string {
  if (typeof value === 'string') {
    return assertString(value, field);
  }
  if ('text' in value) {
    return assertString(value.text, field);
  }
  return rt.storagePort.readFileSync(assertNonEmptyText(value.file, `${field} file`), 'utf-8');
}

function appendEvidence(existing: string, addition: string): string {
  const normalized = assertNonEmptyText(addition, 'evidence-append');
  const current = existing.trim();
  return current ? `${current}\n${normalized}` : normalized;
}

function applyKnowledgeUpdate(
  current: readonly KbEntryId[],
  input: KbWikiUpdateInput,
): { links: KbEntryId[]; contentChanged: boolean; metadataChanged: boolean } {
  let links = [...current];
  let contentChanged = false;
  let metadataChanged = false;
  const addValue = input.knowledgeAdd ?? input.knowledge_add;
  const removeValue = input.knowledgeRemove ?? input.knowledge_remove;
  const reorderValue = input.knowledgeReorder ?? input.knowledge_reorder;

  if (addValue !== undefined) {
    for (const entry of parseLinkList(addValue, 'knowledge-add')) {
      if (!links.includes(entry)) {
        links.push(entry);
        contentChanged = true;
      }
    }
  }

  if (removeValue !== undefined) {
    const removals = new Set(parseLinkList(removeValue, 'knowledge-remove'));
    const nextLinks = links.filter((entry) => !removals.has(entry));
    if (!sameOrderedEntries(links, nextLinks)) {
      links = nextLinks;
      contentChanged = true;
    }
  }

  if (reorderValue !== undefined) {
    const reordered = parseLinkList(reorderValue, 'knowledge-reorder');
    if (!sameEntrySet(reordered, links)) {
      throw new Error('knowledge-reorder must contain exactly the current Knowledge links');
    }
    if (!sameOrderedEntries(reordered, links)) {
      links = reordered;
      metadataChanged = true;
    }
  }

  return { links, contentChanged, metadataChanged };
}

function parseWikiIndexPayload(
  title: string,
  raw: string,
): KbWikiFrontmatter & { title: string; knowledge: KbEntryId[] } {
  const frontmatter = parseWikiFrontmatter(raw);
  const sections = parseWikiBody(extractBody(raw));
  return {
    ...frontmatter,
    title,
    knowledge: extractKnowledgeLinks(sections.knowledge),
  };
}

function applyFrontmatterUpdate(
  frontmatter: KbWikiFrontmatter,
  input: KbWikiUpdateInput,
): { frontmatter: KbWikiFrontmatter; changed: boolean } {
  const next: KbWikiFrontmatter = { ...frontmatter };
  let changed = false;

  const setList = <Key extends keyof Pick<KbWikiFrontmatter, 'tags' | 'references_principles'>>(
    key: Key,
    values: readonly string[] | undefined,
    field: string,
  ): void => {
    if (values === undefined) {
      return;
    }
    const normalized = normalizeStringList(values, field);
    if (!sameOrderedStrings(next[key], normalized)) {
      next[key] = normalized as KbWikiFrontmatter[Key];
      changed = true;
    }
  };

  setList('tags', input.tags, 'tags');
  setList('references_principles', input.references_principles ?? input.referencesPrinciples, 'references_principles');

  if (input.related !== undefined) {
    const related = normalizeEntryReferences(input.related, 'related');
    if (!sameOrderedEntries(next.related ?? [], related)) {
      next.related = related;
      changed = true;
    }
  }

  if (input.updatedAt !== undefined) {
    const updatedAt = assertNonEmptyText(input.updatedAt, 'updatedAt');
    if (next.updatedAt !== updatedAt) {
      next.updatedAt = updatedAt;
      changed = true;
    }
  }

  return { frontmatter: next, changed };
}

export async function applyWikiUpdateLocked(
  rt: KbRuntime,
  mutation: KbMutationEffects,
  input: KbWikiUpdateInput,
): Promise<KbWikiUpdateResponse> {
  const slug = assertWikiSlug(input.slug, 'wiki');
  const wikiPath = rt.wikiPath(slug);

  if (!rt.storagePort.existsSync(wikiPath)) {
    throw new Error(`KB wiki not found: ${slug}`);
  }

  const raw = rt.storagePort.readFileSync(wikiPath, 'utf-8');
  const title = extractTitle(raw);
  const frontmatter = parseWikiFrontmatter(raw);
  const sections = parseWikiBody(extractBody(raw));
  const { frontmatter: frontmatterAfterExplicitUpdates, changed: frontmatterChanged } = applyFrontmatterUpdate(
    frontmatter,
    input,
  );
  const nextSections: WikiSections = { ...sections };
  let contentChanged = false;
  let metadataChanged = frontmatterChanged;

  if (input.understanding !== undefined) {
    const understanding = resolveTextOrFile(rt, input.understanding, 'understanding').trim();
    if (nextSections.understanding !== understanding) {
      nextSections.understanding = understanding;
      contentChanged = true;
    }
  }

  const evidenceAppend = input.evidenceAppend ?? input.evidence_append;
  if (evidenceAppend !== undefined) {
    const evidence = appendEvidence(nextSections.evidence, resolveTextOrFile(rt, evidenceAppend, 'evidence-append'));
    if (nextSections.evidence !== evidence) {
      nextSections.evidence = evidence;
      contentChanged = true;
    }
  }

  const existingKnowledge = extractKnowledgeLinks(nextSections.knowledge);
  const knowledgeUpdate = applyKnowledgeUpdate(existingKnowledge, input);
  if (knowledgeUpdate.contentChanged || knowledgeUpdate.metadataChanged) {
    nextSections.knowledge = formatKnowledgeLinks(knowledgeUpdate.links);
    contentChanged = contentChanged || knowledgeUpdate.contentChanged;
    metadataChanged = metadataChanged || knowledgeUpdate.metadataChanged;
    // Knowledge↔Evidence 1:1 sync — removing a Knowledge link drops its trailing Evidence row.
    const remaining = new Set(knowledgeUpdate.links);
    const removedEntryIds = existingKnowledge.filter((entryId) => !remaining.has(entryId));
    if (removedEntryIds.length > 0) {
      const syncedEvidence = syncEvidenceForRemovedKnowledge(nextSections.evidence, removedEntryIds);
      if (syncedEvidence !== nextSections.evidence) {
        nextSections.evidence = syncedEvidence;
        contentChanged = true;
      }
    }
  }

  if (!contentChanged && !metadataChanged) {
    return { path: wikiPath };
  }

  const nextFrontmatter: KbWikiFrontmatter = {
    ...frontmatterAfterExplicitUpdates,
    updatedAt: input.updatedAt ?? nowIsoString(rt.time),
  };
  const nextRaw = serializeWiki(nextFrontmatter, title, buildWikiBody(nextSections));

  if (nextRaw === raw) {
    return { path: wikiPath };
  }

  const lane: KbIndexMutationLane = contentChanged ? 'content' : 'metadata';
  const parsed = parseWikiIndexPayload(title, nextRaw);

  commitCorpusEntryLocked(rt, mutation, {
    path: wikiPath,
    raw: nextRaw,
    manifestDeltas: captureWikiManifestDeltas(slug, nextRaw),
    indexUpdate: (index) => {
      setEntry(
        index,
        wikiEntryId(slug),
        buildWikiIndexEntry({
          slug,
          ...parsed,
        }),
      );
    },
    lane,
    reason: `KB text snapshot is stale after kb_wiki_update (${lane}).`,
  });

  return { path: wikiPath };
}

export async function updateWiki(rt: KbRuntime, input: KbWikiUpdateInput): Promise<KbWikiUpdateResponse> {
  const slug = assertWikiSlug(input.slug, 'wiki');
  return rt.withMutationLock(async (mutation) => applyWikiUpdateLocked(rt, mutation, { ...input, slug }));
}
