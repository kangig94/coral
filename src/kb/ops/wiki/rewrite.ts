import { nowIsoString } from '../../../infra/time.js';
import { captureWikiManifestDeltas } from '../../corpus/manifest-authority.js';
import { commitCorpusEntryLocked } from '../../corpus/index-mutations.js';
import {
  extractBody,
  extractTitle,
  parseEvidenceRow,
  parseWikiBody,
  parseWikiFrontmatter,
  serializeWiki,
  type WikiBodySections,
} from '../../corpus/frontmatter.js';
import { buildWikiIndexEntry } from '../../corpus/index-records.js';
import { extractKnowledgeLinks } from '../../corpus/wiki-links.js';
import {
  entryIdToEvidenceSlug,
  entryIdToVaultLink,
  setEntry,
  wikiEntryId,
  type KbEntryId,
  type KbWikiFrontmatter,
} from '../../entry-types.js';
import { assertWikiSlug } from '../../validation.js';
import type { KbIndexMutationLane, KbMutationEffects, KbRuntime } from '../../contract.js';

const DEFAULT_WIKI_REWRITE_REASON = 'KB text snapshot is stale after wiki rewrite.';

export type WikiRewriteCurrent = {
  slug: string;
  path: string;
  raw: string;
  title: string;
  body: string;
  frontmatter: KbWikiFrontmatter;
  sections: WikiBodySections;
  knowledge: KbEntryId[];
};

export type WikiRewritePatch = {
  title?: string;
  body?: string;
  sections?: Partial<WikiBodySections>;
  frontmatter?: Partial<KbWikiFrontmatter>;
  lane?: KbIndexMutationLane;
  reason?: string;
};

export type WikiRewriteMutationFn = (
  current: WikiRewriteCurrent,
) => WikiRewritePatch | null | undefined | Promise<WikiRewritePatch | null | undefined>;

export type RewriteWikiInMutationOptions = {
  lane: KbIndexMutationLane;
  reason?: string;
};

function serializeWikiBodySections(sections: WikiBodySections): string {
  return [
    '## Understanding',
    sections.understanding.trim(),
    '## Knowledge',
    sections.knowledge.trim(),
    '## Evidence',
    sections.evidence.trim(),
  ]
    .join('\n\n')
    .trim();
}

function mergeWikiSections(current: WikiBodySections, patch: Partial<WikiBodySections> | undefined): WikiBodySections {
  if (patch === undefined) {
    return current;
  }

  return {
    understanding: patch.understanding ?? current.understanding,
    knowledge: patch.knowledge ?? current.knowledge,
    evidence: patch.evidence ?? current.evidence,
  };
}

function uniqueEntryIds(entryIds: readonly KbEntryId[]): KbEntryId[] {
  return [...new Set(entryIds)];
}

function readCurrentWiki(rt: KbRuntime, slug: string): WikiRewriteCurrent {
  const path = rt.wikiPath(slug);
  if (!rt.storagePort.existsSync(path)) {
    throw new Error(`KB wiki not found: ${path}`);
  }

  const raw = rt.storagePort.readFileSync(path, 'utf-8');
  const body = extractBody(raw);
  const sections = parseWikiBody(body);
  return {
    slug,
    path,
    raw,
    title: extractTitle(raw),
    body,
    frontmatter: parseWikiFrontmatter(raw),
    sections,
    knowledge: extractKnowledgeLinks(sections.knowledge),
  };
}

function removeKnowledgeLineForEntry(lines: readonly string[], entryId: KbEntryId): string[] {
  const link = entryIdToVaultLink(entryId);
  return lines.filter((line) => !line.includes(link));
}

function knowledgeLines(knowledge: string): string[] {
  return knowledge
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function prependKnowledgeLinks(knowledge: string, entryIds: readonly KbEntryId[]): string {
  const unique = uniqueEntryIds(entryIds);
  const remaining = unique.reduce(
    (lines, entryId) => removeKnowledgeLineForEntry(lines, entryId),
    knowledgeLines(knowledge),
  );
  return [...unique.map((entryId) => `- ${entryIdToVaultLink(entryId)}`), ...remaining].join('\n').trim();
}

/**
 * Knowledge↔Evidence stay 1:1. When a Knowledge link is removed (intentional —
 * the user judges the link wrong/superseded), drop the trailing Evidence row
 * tied to that slug so it cannot become a misleading "this used to be true"
 * claim. Git history preserves the audit trail.
 */
function removeLastEvidenceRowForSlug(evidence: string, slug: string): string {
  const lines = evidence.split(/\r?\n/u);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = parseEvidenceRow(lines[i]);
    if (parsed !== null && parsed.slug === slug) {
      lines.splice(i, 1);
      return lines.join('\n').trim();
    }
  }
  return evidence;
}

export function syncEvidenceForRemovedKnowledge(evidence: string, removedEntryIds: readonly KbEntryId[]): string {
  let next = evidence;
  for (const entryId of removedEntryIds) {
    next = removeLastEvidenceRowForSlug(next, entryIdToEvidenceSlug(entryId));
  }
  return next;
}

function diffRemovedEntryIds(before: readonly KbEntryId[], after: readonly KbEntryId[]): KbEntryId[] {
  const remaining = new Set(after);
  return before.filter((entryId) => !remaining.has(entryId));
}

/**
 * Self-organizing list via the transposition heuristic (Rivest 1976,
 * Bitner 1979): each touch swaps the matched link with its immediate
 * predecessor. Under stationary access frequencies, transposition
 * converges to the optimal frequency-sorted order, while move-to-front
 * over-reacts to single accesses and never converges.
 *
 * Per-event semantics: each entry in `entryIds` is one touch event and
 * causes at most one swap. Multiple events for the same link in one
 * batch each count as a separate swap (e.g. 5 touches = 5 positions up).
 * Touched links already at index 0, or absent from the list, no-op.
 */
function bubbleUpKnowledgeLinks(knowledge: string, entryIds: readonly KbEntryId[]): string {
  const lines = knowledgeLines(knowledge);
  for (const entryId of entryIds) {
    const link = entryIdToVaultLink(entryId);
    const index = lines.findIndex((line) => line.includes(link));
    if (index <= 0) {
      continue;
    }
    [lines[index - 1], lines[index]] = [lines[index], lines[index - 1]];
  }
  return lines.join('\n').trim();
}

export async function rewriteWiki(
  rt: KbRuntime,
  slug: string,
  mutationFn: WikiRewriteMutationFn,
): Promise<{ path: string }> {
  const wikiSlug = assertWikiSlug(slug, 'wiki');
  return rt.withMutationLock((mutation) =>
    rewriteWikiInMutation(rt, mutation, wikiSlug, mutationFn, {
      lane: 'content',
      reason: DEFAULT_WIKI_REWRITE_REASON,
    }),
  );
}

export async function rewriteWikiInMutation(
  rt: KbRuntime,
  mutation: KbMutationEffects,
  slug: string,
  mutationFn: WikiRewriteMutationFn,
  options: RewriteWikiInMutationOptions,
): Promise<{ path: string }> {
  const wikiSlug = assertWikiSlug(slug, 'wiki');
  const current = readCurrentWiki(rt, wikiSlug);
  const patch = await mutationFn(current);
  if (patch === null || patch === undefined) {
    return { path: current.path };
  }

  const title = patch.title ?? current.title;
  const frontmatterPatch = patch.frontmatter ?? {};
  const sectionsTouched = patch.body !== undefined || patch.sections !== undefined;
  const patchedSections =
    patch.body !== undefined
      ? parseWikiBody(patch.body)
      : mergeWikiSections(current.sections, patch.sections);
  const patchedKnowledge = extractKnowledgeLinks(patchedSections.knowledge);
  const removedKnowledge = sectionsTouched
    ? diffRemovedEntryIds(current.knowledge, patchedKnowledge)
    : [];
  const nextSections =
    removedKnowledge.length === 0
      ? patchedSections
      : { ...patchedSections, evidence: syncEvidenceForRemovedKnowledge(patchedSections.evidence, removedKnowledge) };
  const body = !sectionsTouched
    ? current.body
    : patch.body !== undefined && removedKnowledge.length === 0
      ? patch.body
      : serializeWikiBodySections(nextSections);
  const nextKnowledge = extractKnowledgeLinks(nextSections.knowledge);
  const frontmatter = {
    ...current.frontmatter,
    ...frontmatterPatch,
  };
  const withoutTimestampRaw = serializeWiki(frontmatter, title, body);
  const nextFrontmatter =
    withoutTimestampRaw === current.raw
      ? frontmatter
      : {
          ...frontmatter,
          updatedAt: nowIsoString(rt.time),
        };
  const nextRaw = serializeWiki(nextFrontmatter, title, body);

  if (nextRaw === current.raw) {
    return { path: current.path };
  }

  commitCorpusEntryLocked(rt, mutation, {
    path: current.path,
    raw: nextRaw,
    manifestDeltas: captureWikiManifestDeltas(wikiSlug, nextRaw),
    indexUpdate: (index) => {
      setEntry(
        index,
        wikiEntryId(wikiSlug),
        buildWikiIndexEntry({
          slug: wikiSlug,
          title,
          ...nextFrontmatter,
          knowledge: nextKnowledge,
        }),
      );
    },
    lane: patch.lane ?? options.lane,
    reason: patch.reason ?? options.reason ?? DEFAULT_WIKI_REWRITE_REASON,
  });

  return { path: current.path };
}

export function bubbleUpWikiKnowledgeInMutation(
  rt: KbRuntime,
  mutation: KbMutationEffects,
  slug: string,
  entryIds: readonly KbEntryId[],
): Promise<{ path: string }> {
  return rewriteWikiInMutation(
    rt,
    mutation,
    slug,
    (current) => {
      if (entryIds.length === 0) {
        return undefined;
      }
      const knowledge = bubbleUpKnowledgeLinks(current.sections.knowledge, entryIds);
      return knowledge === current.sections.knowledge
        ? undefined
        : {
            sections: {
              knowledge,
            },
          };
    },
    {
      lane: 'metadata',
      reason: 'KB wiki metadata changed after touch drain.',
    },
  );
}

export function bubbleUpWikiKnowledge(
  rt: KbRuntime,
  slug: string,
  entryIds: readonly KbEntryId[],
): Promise<{ path: string }> {
  return rewriteWiki(rt, slug, (current) => {
    if (entryIds.length === 0) {
      return undefined;
    }
    const knowledge = bubbleUpKnowledgeLinks(current.sections.knowledge, entryIds);
    return knowledge === current.sections.knowledge
      ? undefined
      : {
          sections: {
            knowledge,
          },
          lane: 'metadata',
          reason: 'KB wiki metadata changed after touch drain.',
        };
  });
}

export function prependWikiKnowledgeLinkInMutation(
  rt: KbRuntime,
  mutation: KbMutationEffects,
  slug: string,
  entryId: KbEntryId,
): Promise<{ path: string }> {
  return rewriteWikiInMutation(
    rt,
    mutation,
    slug,
    (current) => ({
      sections: {
        knowledge: prependKnowledgeLinks(current.sections.knowledge, [entryId]),
      },
    }),
    {
      lane: 'content',
      reason: 'KB text snapshot is stale after kb_promote wiki update.',
    },
  );
}
