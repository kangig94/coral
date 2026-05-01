import type { KbRuntime } from '../../contract.js';
import { isCommunityEntry, type KbIndex } from '../../entry-types.js';
import { computeCommunityTopologyFingerprint } from './detection.js';
import { computeCommunitySummaryInputFingerprints } from './summary.js';
import { readCurateState, type CurateState } from '../state/index.js';
import { curateDb } from '../db-access.js';

type CommunityFreshnessRuntime = Pick<KbRuntime, 'notePath' | 'sourcePath' | 'storagePort'>;

export function areCommunityDocumentsFresh(
  kb: KbRuntime,
  index: KbIndex,
  state?: CurateState,
): boolean {
  // Avoid touching curate state when there are no community entries.
  const hasCommunityEntries = Object.values(index.entries).some(isCommunityEntry);
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
  const communityEntries = Object.values(index.entries).filter(isCommunityEntry);
  if (communityEntries.length === 0) {
    return true;
  }

  const topologyHash = computeCommunityTopologyFingerprint(index);
  if (state.communityTopologyHash !== topologyHash || state.communitySummaryTopologyHash !== topologyHash) {
    return false;
  }

  try {
    const communities = communityEntries.map((community) => ({
      slug: community.slug,
      title: community.title,
      level: community.level,
      members: community.members,
      ...(community.children === undefined ? {} : { children: community.children }),
      ...(community.summary === undefined ? {} : { summary: community.summary }),
    }));
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
  const storedEntries = Object.entries(storedFingerprints ?? {})
    .filter(([slug]) => slug in currentFingerprints)
    .sort(([left], [right]) => left.localeCompare(right));

  return (
    currentEntries.length === storedEntries.length &&
    currentEntries.every(
      ([slug, fingerprint], index) => storedEntries[index]?.[0] === slug && storedEntries[index]?.[1] === fingerprint,
    )
  );
}
