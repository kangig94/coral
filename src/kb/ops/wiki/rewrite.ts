import { nowIsoString } from '../../../infra/time.js';
import { captureWikiManifestDeltas } from '../../corpus/manifest-authority.js';
import { commitCorpusEntryLocked } from '../../corpus/index-mutations.js';
import {
  extractBody,
  extractTitle,
  parseKnowledgeBlocks,
  parseWikiBody,
  parseWikiFrontmatter,
  serializeKnowledgeBlocks,
  serializeWiki,
  type KnowledgeBlock,
  type WikiBodySections,
} from '../../corpus/frontmatter.js';
import { buildWikiIndexEntry } from '../../corpus/index-records.js';
import { extractKnowledgeLinks } from '../../corpus/wiki-links.js';
import {
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
  return ['## Understanding', sections.understanding.trim(), '## Knowledge', sections.knowledge.trim()]
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
  };
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

function blockHeaderFor(entryId: KbEntryId): string {
  return `- ${entryIdToVaultLink(entryId)}`;
}

/**
 * Prepend new Knowledge entries to the front of the section. If a link is
 * already present, its existing block (header + evidence sub-bullets) is
 * moved to the front intact. New links are added with empty evidence lists.
 */
function prependKnowledgeLinks(knowledge: string, entryIds: readonly KbEntryId[]): string {
  const seen = new Set<KbEntryId>();
  const ordered: KbEntryId[] = [];
  for (const entryId of entryIds) {
    if (!seen.has(entryId)) {
      seen.add(entryId);
      ordered.push(entryId);
    }
  }

  const blocks = parseKnowledgeBlocks(knowledge);
  const remaining = blocks.filter((block) => !seen.has(block.entryId));
  const front: KnowledgeBlock[] = ordered.map((entryId) => {
    const existing = blocks.find((block) => block.entryId === entryId);
    return existing ?? { entryId, header: blockHeaderFor(entryId), evidence: [] };
  });

  return serializeKnowledgeBlocks([...front, ...remaining]);
}

/**
 * Self-organizing list via the transposition heuristic (Rivest 1976,
 * Bitner 1979): each touch swaps the matched Knowledge block with its
 * immediate predecessor. The block carries its evidence sub-bullets, so
 * physical ordering and evidence stay grouped — no separate sync needed.
 *
 * Per-event semantics: each entry in `entryIds` is one touch event and
 * causes at most one swap. Multiple events for the same link in one
 * batch each count as a separate swap (e.g. 5 touches = 5 positions up).
 * Touched links already at index 0, or absent from the list, no-op.
 */
function bubbleUpKnowledgeLinks(knowledge: string, entryIds: readonly KbEntryId[]): string {
  const blocks = parseKnowledgeBlocks(knowledge);
  for (const entryId of entryIds) {
    const index = blocks.findIndex((block) => block.entryId === entryId);
    if (index <= 0) {
      continue;
    }
    [blocks[index - 1], blocks[index]] = [blocks[index], blocks[index - 1]];
  }
  return serializeKnowledgeBlocks(blocks);
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
  const nextSections =
    patch.body !== undefined ? parseWikiBody(patch.body) : mergeWikiSections(current.sections, patch.sections);
  const body = !sectionsTouched ? current.body : (patch.body ?? serializeWikiBodySections(nextSections));
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
