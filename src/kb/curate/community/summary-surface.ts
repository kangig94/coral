import { nowIsoString } from '../../../infra/time.js';
import { captureCommunityManifestDelta } from '../../corpus/manifest-authority.js';
import { writeFileAtomic } from '../../corpus/file-atomic.js';
import { recordMetadataMutation } from '../../corpus/index/mutations.js';
import { compareLocale } from '../../validation.js';
import type { KbRuntime } from '../../contract.js';
import type { ExistingGeneratedCommunity } from './contracts.js';
import { loadExistingCommunityState, renderCommunityDocument } from './documents.js';
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
  'communitiesDir' | 'notePath' | 'sourcePath' | 'storagePort' | 'readIndexOrEmpty'
>;

function bySlug(generated: ExistingGeneratedCommunity[]): Map<string, ExistingGeneratedCommunity> {
  const map = new Map<string, ExistingGeneratedCommunity>();
  for (const community of generated) {
    map.set(community.slug, community);
  }
  return map;
}

/**
 * Communities whose stored summary is missing or whose input fingerprint no
 * longer matches the current inputs, ordered children-before-parents (level
 * ascending) so a parent is only re-summarized after its children are fresh.
 * A converged corpus returns an empty list — the agent then has nothing to do.
 */
export function listStaleCommunities(kb: CommunitySummaryReadRuntime): StaleCommunity[] {
  const { generated } = loadExistingCommunityState(kb);
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
  const { generated } = loadExistingCommunityState(kb);
  const community = generated.find((entry) => entry.slug === slug);
  if (community === undefined) {
    return null;
  }
  const { kind, input } = buildCommunitySummaryInput(community, bySlug(generated), kb, kb.readIndexOrEmpty());
  return { slug, level: community.level, kind, input };
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

  let written = false;
  await kb.withMutationLock(async (mutation) => {
    const { generated } = loadExistingCommunityState(kb);
    const community = generated.find((entry) => entry.slug === slug);
    if (community === undefined) {
      return;
    }

    const summaryInputFingerprint = computeCommunitySummaryInputFingerprintForCommunity(
      community,
      bySlug(generated),
      kb,
      kb.readIndexOrEmpty(),
    );
    const content = renderCommunityDocument({
      title: community.title,
      members: community.members,
      level: community.level,
      ...(community.parent === undefined ? {} : { parent: community.parent }),
      ...(community.children === undefined ? {} : { children: community.children }),
      summary,
      summaryInputFingerprint,
      createdAt: community.createdAt,
      updatedAt: nowIsoString(kb.time).slice(0, 10),
    });

    writeFileAtomic(kb, kb.communityPath(slug), content);
    mutation.queueManifestAuthorityDelta(captureCommunityManifestDelta(slug, content));
    recordMetadataMutation(kb, CURATE_STALE_REASON);
    written = true;
  });

  return { written };
}
