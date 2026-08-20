import type { KbRuntime } from '../../contract.js';
import { isCommunityEntry, type CommunityEntry, type KbIndex } from '../../entry-types.js';
import { computeCommunitySummaryInputFingerprints } from './summary.js';

type CommunityFreshnessRuntime = Pick<KbRuntime, 'notePath' | 'sourcePath' | 'storagePort'>;

export function areCommunityDocumentsFresh(kb: KbRuntime, index: KbIndex): boolean {
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
  return isCommunityStateFreshForIndex(kb, index);
}

function isCommunityStateFreshForIndex(kb: CommunityFreshnessRuntime, index: KbIndex): boolean {
  const communityEntries: CommunityEntry[] = [];
  for (const entry of Object.values(index.entries)) {
    if (isCommunityEntry(entry)) {
      communityEntries.push(entry);
    }
  }
  if (communityEntries.length === 0) {
    return true;
  }

  try {
    const communities: Array<{
      slug: string;
      title: string;
      level: number;
      members: string[];
      children?: string[];
      summary?: string;
      summaryInputFingerprint?: string;
    }> = [];
    for (const community of communityEntries) {
      communities.push({
        slug: community.slug,
        title: community.title,
        level: community.level,
        members: community.members,
        ...(community.children === undefined ? {} : { children: community.children }),
        ...(community.summary === undefined ? {} : { summary: community.summary }),
        ...(community.summaryInputFingerprint === undefined
          ? {}
          : { summaryInputFingerprint: community.summaryInputFingerprint }),
      });
    }
    const currentFingerprints = computeCommunitySummaryInputFingerprints(communities, kb, index);
    return isCommunitySummaryFresh(currentFingerprints, communityEntries);
  } catch {
    return false;
  }
}

function isCommunitySummaryFresh(
  currentFingerprints: Readonly<Record<string, string>>,
  communities: readonly CommunityEntry[],
): boolean {
  const currentEntries = Object.entries(currentFingerprints).sort(([left], [right]) => left.localeCompare(right));
  const storedEntries = communities
    .flatMap(
      (community): Array<[string, string]> =>
        community.summaryInputFingerprint === undefined ? [] : [[community.slug, community.summaryInputFingerprint]],
    )
    .filter(([slug]) => slug in currentFingerprints)
    .sort(([left], [right]) => left.localeCompare(right));

  if (currentEntries.length === 0 || currentEntries.length !== storedEntries.length) {
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
