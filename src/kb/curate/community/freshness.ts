import type { KbRuntime } from '../../contract.js';
import { isCommunityEntry, type CommunityEntry, type KbIndex } from '../../entry-types.js';
import { computeCommunityTopologyFingerprint } from './detection.js';
import { computeCommunitySummaryInputFingerprints } from './summary.js';
import { readCurateState, type CurateState } from '../state/index.js';
import { curateDb } from '../db-access.js';

type CommunityFreshnessRuntime = Pick<KbRuntime, 'notePath' | 'sourcePath' | 'storagePort'>;

export function areCommunityDocumentsFresh(kb: KbRuntime, index: KbIndex, state?: CurateState): boolean {
  // Avoid touching curate state when there are no community entries.
  let hasCommunityEntries = false;
  for (const entry of Object.values(index.entries)) {
    if (isCommunityEntry(entry)) {
      hasCommunityEntries = true;
      break;
    }
  }
  if (!hasCommunityEntries) {
    return true;
  }
  return isCommunityStateFreshForIndex(state ?? readCurateState(curateDb(kb)), kb, index);
}

function isCommunityStateFreshForIndex(
  state: Pick<
    CurateState,
    'communityTopologyHash' | 'communitySummaryTopologyHash' | 'communitySummaryInputFingerprints'
  >,
  kb: CommunityFreshnessRuntime,
  index: KbIndex,
): boolean {
  const communityEntries: CommunityEntry[] = [];
  for (const entry of Object.values(index.entries)) {
    if (isCommunityEntry(entry)) {
      communityEntries.push(entry);
    }
  }
  if (communityEntries.length === 0) {
    return true;
  }

  const topologyHash = computeCommunityTopologyFingerprint(index);
  if (state.communityTopologyHash !== topologyHash || state.communitySummaryTopologyHash !== topologyHash) {
    return false;
  }

  try {
    const communities: Array<{
      slug: string;
      title: string;
      level: number;
      members: string[];
      children?: string[];
      summary?: string;
    }> = [];
    for (const community of communityEntries) {
      communities.push({
        slug: community.slug,
        title: community.title,
        level: community.level,
        members: community.members,
        ...(community.children === undefined ? {} : { children: community.children }),
        ...(community.summary === undefined ? {} : { summary: community.summary }),
      });
    }
    const currentFingerprints = computeCommunitySummaryInputFingerprints(communities, kb, index);
    return isCommunitySummaryFresh(currentFingerprints, state.communitySummaryInputFingerprints);
  } catch {
    return false;
  }
}

function isCommunitySummaryFresh(
  currentFingerprints: Readonly<Record<string, string>>,
  storedFingerprints: Readonly<Record<string, string>> | undefined,
): boolean {
  const currentEntries = Object.entries(currentFingerprints).sort(([left], [right]) => left.localeCompare(right));
  const storedEntries: Array<[string, string]> = [];
  for (const [slug, fingerprint] of Object.entries(storedFingerprints ?? {})) {
    if (slug in currentFingerprints) {
      storedEntries.push([slug, fingerprint]);
    }
  }
  storedEntries.sort(([left], [right]) => left.localeCompare(right));

  if (currentEntries.length !== storedEntries.length) {
    return false;
  }
  for (let index = 0; index < currentEntries.length; index += 1) {
    const [slug, fingerprint] = currentEntries[index];
    const storedEntry = storedEntries[index];
    if (storedEntry?.[0] !== slug || storedEntry[1] !== fingerprint) {
      return false;
    }
  }
  return true;
}
