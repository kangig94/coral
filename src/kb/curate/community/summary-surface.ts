import { nowIsoString } from '../../../infra/time.js';
import { captureCommunityManifestDelta } from '../../corpus/manifest-authority.js';
import { writeFileAtomic } from '../../corpus/file-atomic.js';
import { recordMetadataMutation } from '../../corpus/index/mutations.js';
import { isNoEntryError } from '../../../infra/fs-errors.js';
import {
  extractBody,
  extractTitle,
  parseCommunityFrontmatter,
  parseMembersFromBody,
  parseSummaryFromBody,
} from '../../corpus/frontmatter.js';
import { compareLocale } from '../../validation.js';
import type { KbRuntime } from '../../contract.js';
import type { ExistingGeneratedCommunity } from './contracts.js';
import { renderCommunityDocument } from './documents.js';
import { CURATE_STALE_REASON } from '../operations.js';
import {
  buildCommunitySummaryInput,
  computeCommunitySummaryInputFingerprintForCommunity,
  normalizeGeneratedSummary,
} from './summary.js';

/**
 * Agent-facing surface for community summarization. A single curate agent drives
 * the whole pass through three operations:
 *   - {@link listStaleCommunities} → the work-list (stale only, dependency order),
 *   - {@link readCommunitySummaryInput} → the input context for one community,
 *   - {@link applyCommunitySummary} → persist a summary the agent produced.
 *
 * Freshness authority stays in the backend: the agent supplies only summary
 * TEXT; the input fingerprint that gates re-summarization is computed here from
 * the canonical inputs. This keeps the gate deterministic and prevents the churn
 * that an agent-computed fingerprint would reintroduce.
 */

export type StaleCommunity = { slug: string; level: number };
export type CommunitySummaryInput = { slug: string; level: number; kind: 'leaf' | 'parent'; input: string };
export type CommunitySummaryReadRuntime = Pick<
  KbRuntime,
  | 'generatedCommunityProjectionStore'
  | 'communityPath'
  | 'notePath'
  | 'sourcePath'
  | 'storagePort'
  | 'readIndexOrEmpty'
>;

function bySlug(generated: ExistingGeneratedCommunity[]): Map<string, ExistingGeneratedCommunity> {
  const map = new Map<string, ExistingGeneratedCommunity>();
  for (const community of generated) {
    map.set(community.slug, community);
  }
  return map;
}

function generatedCommunities(kb: CommunitySummaryReadRuntime): ExistingGeneratedCommunity[] {
  return kb.generatedCommunityProjectionStore.readActiveGeneration().records.map((record) => ({
    slug: record.slug,
    title: record.title,
    level: record.level,
    members: [...record.members],
    ...(record.parent === undefined ? {} : { parent: record.parent }),
    ...(record.children === undefined ? {} : { children: [...record.children] }),
    ...(record.summary === undefined ? {} : { summary: record.summary }),
    ...(record.summaryInputFingerprint === undefined
      ? {}
      : { summaryInputFingerprint: record.summaryInputFingerprint }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }));
}

/**
 * Communities whose stored summary is missing or whose input fingerprint no
 * longer matches the current inputs, ordered children-before-parents (level
 * ascending) so a parent is only re-summarized after its children are fresh.
 * A converged corpus returns an empty list — the agent then has nothing to do.
 */
export function listStaleCommunities(kb: CommunitySummaryReadRuntime): StaleCommunity[] {
  const generated = generatedCommunities(kb);
  const index = kb.readIndexOrEmpty();
  const communities = bySlug(generated);
  const stale: StaleCommunity[] = [];
  for (const community of generated) {
    let fingerprint: string;
    try {
      fingerprint = computeCommunitySummaryInputFingerprintForCommunity(community, communities, kb, index);
    } catch {
      // A parent whose children are not yet summarized cannot be fingerprinted;
      // it surfaces on a later call once the lower levels are filled in.
      continue;
    }
    if (community.summary === undefined || community.summaryInputFingerprint !== fingerprint) {
      stale.push({ slug: community.slug, level: community.level });
    }
  }
  stale.sort((left, right) =>
    left.level !== right.level ? left.level - right.level : compareLocale(left.slug, right.slug),
  );
  return stale;
}

/** The LLM input context for one community, or null when the slug is unknown. */
export function readCommunitySummaryInput(kb: CommunitySummaryReadRuntime, slug: string): CommunitySummaryInput | null {
  const generated = generatedCommunities(kb);
  const community = generated.find((entry) => entry.slug === slug);
  if (community === undefined) {
    const authored = loadAuthoredCommunity(kb, slug);
    if (authored === null) {
      return null;
    }
    const { kind, input } = buildCommunitySummaryInput(authored, bySlug([authored]), kb, kb.readIndexOrEmpty());
    return { slug, level: authored.level, kind, input };
  }
  const { kind, input } = buildCommunitySummaryInput(community, bySlug(generated), kb, kb.readIndexOrEmpty());
  return { slug, level: community.level, kind, input };
}

function loadAuthoredCommunity(kb: CommunitySummaryReadRuntime, slug: string): ExistingGeneratedCommunity | null {
  let raw: string;
  try {
    raw = kb.storagePort.readFileSync(kb.communityPath(slug), 'utf-8');
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return null;
    }
    throw error;
  }
  const frontmatter = parseCommunityFrontmatter(raw);
  const body = extractBody(raw);
  return {
    slug,
    title: extractTitle(raw),
    level: frontmatter.level,
    members: parseMembersFromBody(body),
    ...(frontmatter.parent === undefined ? {} : { parent: frontmatter.parent }),
    ...(frontmatter.children === undefined ? {} : { children: frontmatter.children }),
    summary: parseSummaryFromBody(body),
    ...(frontmatter.summaryInputFingerprint === undefined
      ? {}
      : { summaryInputFingerprint: frontmatter.summaryInputFingerprint }),
    createdAt: frontmatter.createdAt,
    updatedAt: frontmatter.updatedAt,
  };
}

/**
 * Persist one community's summary. The input fingerprint is recomputed here (not
 * supplied by the agent) and written alongside the summary so the freshness gate
 * closes for this community on the next pass. Returns whether a file was written
 * (false when the slug is unknown).
 */
export async function applyCommunitySummary(
  kb: KbRuntime,
  slug: string,
  rawSummary: string,
): Promise<{ written: boolean }> {
  const summary = normalizeGeneratedSummary(rawSummary);
  if (summary === undefined) {
    throw new Error(`Refusing to store an empty summary for community ${slug}.`);
  }

  const generated = generatedCommunities(kb);
  const generatedCommunity = generated.find((entry) => entry.slug === slug);
  if (generatedCommunity !== undefined) {
    const summaryInputFingerprint = computeCommunitySummaryInputFingerprintForCommunity(
      generatedCommunity,
      bySlug(generated),
      kb,
      kb.readIndexOrEmpty(),
    );
    const staged = kb.generatedCommunityProjectionStore.updateGeneratedSummary({
      slug,
      summary,
      summaryInputFingerprint,
    });
    if (staged === null) {
      return { written: false };
    }

    let written = false;
    try {
      await kb.withMutationLock(() => {
        const currentSnapshot = kb.captureCorpusSnapshot();
        const result = kb.generatedCommunityProjectionStore.adoptStagedGeneration(staged, currentSnapshot);
        if (result.status === 'discarded') {
          return;
        }
        kb.invalidateTextSnapshot('generated-community-summary');
        kb.publishGeneratedCommunityProjection({
          snapshot: currentSnapshot,
          generatedCommunityGeneration: result.generation,
          generatedCommunityDocsHash: result.generatedCommunityDocsHash,
        });
        written = true;
      });
    } finally {
      if (!written) {
        kb.generatedCommunityProjectionStore.discardStagedGeneration(staged);
      }
    }
    return { written };
  }

  const authoredCommunity = loadAuthoredCommunity(kb, slug);
  if (authoredCommunity === null) {
    return { written: false };
  }

  let written = false;
  await kb.withMutationLock(async (mutation) => {
    const summaryInputFingerprint = computeCommunitySummaryInputFingerprintForCommunity(
      authoredCommunity,
      bySlug([authoredCommunity]),
      kb,
      kb.readIndexOrEmpty(),
    );
    const content = renderCommunityDocument({
      title: authoredCommunity.title,
      members: authoredCommunity.members,
      level: authoredCommunity.level,
      ...(authoredCommunity.parent === undefined ? {} : { parent: authoredCommunity.parent }),
      ...(authoredCommunity.children === undefined ? {} : { children: authoredCommunity.children }),
      summary,
      summaryInputFingerprint,
      createdAt: authoredCommunity.createdAt,
      updatedAt: nowIsoString(kb.time).slice(0, 10),
    });

    writeFileAtomic(kb, kb.communityPath(slug), content);
    mutation.queueManifestAuthorityDelta(captureCommunityManifestDelta(slug, content));
    recordMetadataMutation(kb, CURATE_STALE_REASON);
    written = true;
  });

  return { written };
}
