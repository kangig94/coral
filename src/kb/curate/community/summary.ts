import type { KbRuntime } from '../../contract.js';
import { isNoteEntry, isSourceEntry, type KbIndex } from '../../entry-types.js';
import { loadKbNote, loadKbSource } from '../../read.js';
import { compareLocale, stripMarkdownCodeFences } from '../../validation.js';
import { communitySlugFromReference, computeTextFingerprint, uniqueSorted } from './identity.js';

const COMMUNITY_SUMMARY_DOCUMENT_LIMIT = 3;
const COMMUNITY_SUMMARY_EXCERPT_MAX_CHARS = 800;

type SummaryCommunity = {
  slug: string;
  title: string;
  level: number;
  members: string[];
  children?: string[];
  summary?: string;
};

type RepresentativeDocument = {
  kind: 'note' | 'source';
  slug: string;
  title: string;
  overlapTags: string[];
  excerpt: string;
};

type RepresentativeDocumentCandidate = Omit<RepresentativeDocument, 'excerpt'>;

type ChildCommunitySummary = {
  slug: string;
  title: string;
  members: string[];
  summary: string;
};

function trimSummaryExcerpt(body: string, maxChars: number): string {
  const normalized = body.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return normalized.slice(0, maxChars).trimEnd();
}

function selectRepresentativeDocuments(
  kb: Pick<KbRuntime, 'notePath' | 'sourcePath' | 'storagePort'>,
  index: KbIndex,
  members: string[],
): RepresentativeDocument[] {
  const memberSet = new Set(members);
  const candidates: RepresentativeDocumentCandidate[] = [];
  for (const entry of Object.values(index.entries)) {
    if (!isNoteEntry(entry) && !isSourceEntry(entry)) {
      continue;
    }

    const matchedTags: string[] = [];
    for (const tag of entry.tags) {
      if (memberSet.has(tag)) {
        matchedTags.push(tag);
      }
    }
    const overlapTags = uniqueSorted(matchedTags);
    if (overlapTags.length === 0) {
      continue;
    }

    candidates.push({
      kind: entry.kind,
      slug: entry.slug,
      title: entry.title,
      overlapTags,
    });
  }

  candidates.sort((left, right) => {
    const overlapDiff = right.overlapTags.length - left.overlapTags.length;
    if (overlapDiff !== 0) {
      return overlapDiff;
    }

    if (left.kind !== right.kind) {
      return left.kind === 'note' ? -1 : 1;
    }

    const titleCompare = compareLocale(left.title, right.title);
    if (titleCompare !== 0) {
      return titleCompare;
    }

    return compareLocale(left.slug, right.slug);
  });

  const documents: RepresentativeDocument[] = [];
  const candidateCount = Math.min(COMMUNITY_SUMMARY_DOCUMENT_LIMIT, candidates.length);
  for (let index = 0; index < candidateCount; index += 1) {
    const candidate = candidates[index];
    const loaded =
      candidate.kind === 'note'
        ? loadKbNote(kb.storagePort, kb.notePath(candidate.slug))
        : loadKbSource(kb.storagePort, kb.sourcePath(candidate.slug));

    documents.push({
      kind: candidate.kind,
      slug: candidate.slug,
      title: loaded.title,
      overlapTags: candidate.overlapTags,
      excerpt: trimSummaryExcerpt(loaded.body, COMMUNITY_SUMMARY_EXCERPT_MAX_CHARS),
    });
  }
  return documents;
}

function representativeDocumentFingerprint(document: RepresentativeDocument): string {
  return computeTextFingerprint(
    JSON.stringify({
      kind: document.kind,
      slug: document.slug,
      overlapTags: document.overlapTags,
      excerpt: document.excerpt,
    }),
  );
}

function leafSummaryFingerprintPayload(
  community: Pick<SummaryCommunity, 'members'>,
  index: KbIndex,
  documents: RepresentativeDocument[],
): string {
  const entityMeta = index.entityMeta;
  const members = uniqueSorted(community.members);
  const entityMetaPayload: Array<{ member: string; type: string; description: string; aliases: string[] }> = [];
  for (const member of members) {
    const meta = entityMeta[member];
    entityMetaPayload.push({
      member,
      type: meta?.type ?? '',
      description: meta?.description ?? '',
      aliases: [...(meta?.aliases ?? [])].sort(compareLocale),
    });
  }

  const excerpts: Array<{ kind: 'note' | 'source'; slug: string; fingerprint: string }> = [];
  for (const document of documents) {
    excerpts.push({
      kind: document.kind,
      slug: document.slug,
      fingerprint: representativeDocumentFingerprint(document),
    });
  }

  return JSON.stringify({
    kind: 'leaf',
    members,
    entityMeta: entityMetaPayload,
    excerpts,
  });
}

function summaryTextFingerprint(summary: string | undefined): string {
  return computeTextFingerprint((summary ?? '').trim());
}

function childCommunitiesForCommunity(
  community: Pick<SummaryCommunity, 'children'>,
  communitiesBySlug: ReadonlyMap<string, SummaryCommunity>,
): ChildCommunitySummary[] {
  const childReferences = [...(community.children ?? [])].sort((left, right) =>
    compareLocale(communitySlugFromReference(left), communitySlugFromReference(right)),
  );

  const children: ChildCommunitySummary[] = [];
  for (const reference of childReferences) {
    const slug = communitySlugFromReference(reference);
    const child = communitiesBySlug.get(slug);
    if (child === undefined) {
      throw new Error(`Missing child community ${reference} while computing parent summary dependencies.`);
    }
    if (child.summary === undefined) {
      throw new Error(`Missing child summary for ${reference} while computing parent summary dependencies.`);
    }

    children.push({
      slug: child.slug,
      title: child.title,
      members: child.members,
      summary: child.summary,
    });
  }
  return children;
}

function parentSummaryFingerprintPayload(
  community: Pick<SummaryCommunity, 'members'>,
  childCommunities: ChildCommunitySummary[],
): string {
  const children: Array<{ slug: string; summaryFingerprint: string }> = [];
  for (const child of childCommunities) {
    children.push({
      slug: child.slug,
      summaryFingerprint: summaryTextFingerprint(child.summary),
    });
  }

  return JSON.stringify({
    kind: 'parent',
    members: uniqueSorted(community.members),
    children,
  });
}

export function computeCommunitySummaryInputFingerprintForCommunity(
  community: SummaryCommunity,
  communitiesBySlug: ReadonlyMap<string, SummaryCommunity>,
  kb: Pick<KbRuntime, 'notePath' | 'sourcePath' | 'storagePort'>,
  index: KbIndex,
): string {
  if (community.children === undefined || community.children.length === 0) {
    return computeTextFingerprint(
      leafSummaryFingerprintPayload(community, index, selectRepresentativeDocuments(kb, index, community.members)),
    );
  }

  return computeTextFingerprint(
    parentSummaryFingerprintPayload(community, childCommunitiesForCommunity(community, communitiesBySlug)),
  );
}

/**
 * Build the LLM input context for (re)summarizing one community — the same
 * instructions + entity/excerpt (leaf) or child-summary (parent) blocks the
 * curate scheduler would have sent. Mirrors the branching of
 * {@link computeCommunitySummaryInputFingerprintForCommunity} so the fingerprint
 * and the agent-visible input describe the same inputs.
 */
export function buildCommunitySummaryInput(
  community: SummaryCommunity,
  communitiesBySlug: ReadonlyMap<string, SummaryCommunity>,
  kb: Pick<KbRuntime, 'notePath' | 'sourcePath' | 'storagePort'>,
  index: KbIndex,
): { kind: 'leaf' | 'parent'; input: string } {
  if (community.children === undefined || community.children.length === 0) {
    return {
      kind: 'leaf',
      input: buildLeafCommunitySummaryPrompt(
        community,
        index,
        selectRepresentativeDocuments(kb, index, community.members),
      ),
    };
  }
  return {
    kind: 'parent',
    input: buildParentCommunitySummaryPrompt(community, childCommunitiesForCommunity(community, communitiesBySlug)),
  };
}

export function computeCommunitySummaryInputFingerprints(
  communities: SummaryCommunity[],
  kb: Pick<KbRuntime, 'notePath' | 'sourcePath' | 'storagePort'>,
  index: KbIndex,
): Record<string, string> {
  const communitiesBySlug = new Map<string, SummaryCommunity>();
  for (const community of communities) {
    communitiesBySlug.set(community.slug, community);
  }
  const orderedCommunities = [...communities].sort((left, right) => {
    if (left.level !== right.level) {
      return left.level - right.level;
    }
    return compareLocale(left.slug, right.slug);
  });

  const fingerprints: Record<string, string> = {};
  for (const community of orderedCommunities) {
    fingerprints[community.slug] = computeCommunitySummaryInputFingerprintForCommunity(
      community,
      communitiesBySlug,
      kb,
      index,
    );
  }
  return fingerprints;
}

function buildLeafCommunitySummaryPrompt(
  community: Pick<SummaryCommunity, 'members'>,
  index: KbIndex,
  documents: RepresentativeDocument[],
): string {
  const entityMeta = index.entityMeta;
  const entityLines: string[] = [];
  for (const member of uniqueSorted(community.members)) {
    const meta = entityMeta[member];
    const typeSegment = meta?.type === undefined ? '' : ` (${meta.type})`;
    const description = meta?.description ?? 'No stored description.';
    entityLines.push(`- ${member}${typeSegment}: ${description}`);
  }
  const excerptBlocks: string[] = [];
  for (const document of documents) {
    excerptBlocks.push(
      [
        `## ${document.kind}:${document.slug}`,
        `Title: ${document.title}`,
        `Overlap entities: ${document.overlapTags.join(', ')}`,
        'Excerpt:',
        document.excerpt,
      ].join('\n'),
    );
  }

  return [
    'Return plain text only. No heading, bullets, or code fences.',
    'Write a concise KB community summary in 2-3 sentences.',
    'Base it only on the entity descriptions and representative excerpts below.',
    'If the excerpts are mixed, describe the shared thread conservatively and do not invent unsupported claims.',
    '',
    'Entity descriptions:',
    ...entityLines,
    '',
    'Representative excerpts:',
    ...excerptBlocks,
  ].join('\n');
}

function buildParentCommunitySummaryPrompt(
  community: Pick<SummaryCommunity, 'members'>,
  childCommunities: ChildCommunitySummary[],
): string {
  const childBlocks: string[] = [];
  for (const child of childCommunities) {
    childBlocks.push(
      [
        `## ${child.slug}`,
        `Title: ${child.title}`,
        `Members: ${child.members.join(', ')}`,
        'Summary:',
        child.summary,
      ].join('\n'),
    );
  }

  const memberLines: string[] = [];
  for (const member of community.members) {
    memberLines.push(`- ${member}`);
  }

  return [
    'Return plain text only. No heading, bullets, or code fences.',
    'Write a concise KB community summary in 2-3 sentences.',
    'Base it only on the child community summaries below.',
    'Synthesize the shared abstraction across the children without inventing unsupported details.',
    '',
    'Parent members:',
    ...memberLines,
    '',
    'Child community summaries:',
    ...childBlocks,
  ].join('\n');
}

export function normalizeGeneratedSummary(raw: string): string | undefined {
  const normalized = stripMarkdownCodeFences(raw).replace(/\s+/g, ' ').trim();
  return normalized ? normalized : undefined;
}

export async function generateCommunitySummary(options: {
  community: SummaryCommunity;
  kb: Pick<KbRuntime, 'notePath' | 'sourcePath' | 'storagePort'>;
  index: KbIndex;
  childCommunities?: ChildCommunitySummary[];
  priorCommunity?: { summary?: string };
  priorSummaryInputFingerprint?: string;
  runClaude: (prompt: string, signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const childCommunities = options.childCommunities?.length ? [...options.childCommunities] : undefined;
  const summaryInputFingerprint =
    childCommunities === undefined
      ? computeTextFingerprint(
          leafSummaryFingerprintPayload(
            options.community,
            options.index,
            selectRepresentativeDocuments(options.kb, options.index, options.community.members),
          ),
        )
      : computeTextFingerprint(parentSummaryFingerprintPayload(options.community, childCommunities));

  if (
    options.priorCommunity?.summary !== undefined &&
    options.priorSummaryInputFingerprint === summaryInputFingerprint
  ) {
    return options.priorCommunity.summary;
  }

  const prompt =
    childCommunities === undefined
      ? buildLeafCommunitySummaryPrompt(
          options.community,
          options.index,
          selectRepresentativeDocuments(options.kb, options.index, options.community.members),
        )
      : buildParentCommunitySummaryPrompt(options.community, childCommunities);

  const rawSummary = await options.runClaude(prompt, options.signal);
  const summary = normalizeGeneratedSummary(rawSummary);
  if (summary === undefined) {
    throw new Error(`Community summary returned empty text for ${options.community.slug}.`);
  }

  return summary;
}
