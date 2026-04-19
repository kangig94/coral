import { nowIsoString } from '../../shared/utils.js';
import { compareLocale } from '../validation.js';
import type { KbRuntime } from '../contracts.js';
import { recordMetadataMutation, writeFileAtomic } from '../mutation-helpers.js';
import { parseKbEntryId } from '../entry-types.js';
import {
  buildCommunityDocuments,
  buildEntityRelationshipGraph,
  computeCommunitySummaryInputFingerprintForCommunity,
  computeCommunityTopologyFingerprint,
  detectCommunities,
  generateCommunityFiles,
  generateCommunitySummary,
  loadExistingCommunityState,
  renderCommunityDocument,
  type ExistingGeneratedCommunity,
} from './community-detection.js';
import { CURATE_STALE_REASON, runCurateClaude } from './operations.js';
import { readCurateState, writeCurateState } from './state.js';
import { rebuildTextArtifactsAndPersistRepairState } from './text-artifacts.js';
import type { SpawnCliFn } from './types.js';

export type RunCommunitySubphaseOptions = {
  signal?: AbortSignal;
  shouldStop?: () => boolean;
};

function communitySlugFromReference(reference: string): string {
  const parsed = parseKbEntryId(reference);
  if (parsed !== null && parsed.startsWith('community:')) {
    return parsed.slice('community:'.length);
  }

  return reference;
}

function normalizedCommunitySummaryFingerprints(
  fingerprints: Readonly<Record<string, string>> | undefined,
  communities: ReadonlyArray<{ slug: string }>,
): Record<string, string> | undefined {
  if (fingerprints === undefined) {
    return undefined;
  }

  const allowedSlugs = new Set(communities.map((community) => community.slug));
  const entries = Object.entries(fingerprints)
    .filter(([slug]) => allowedSlugs.has(slug))
    .sort(([left], [right]) => compareLocale(left, right));

  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function sameCommunitySummaryFingerprints(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([leftKey], [rightKey]) => compareLocale(leftKey, rightKey));
  const rightEntries = Object.entries(right ?? {}).sort(([leftKey], [rightKey]) => compareLocale(leftKey, rightKey));
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([slug, fingerprint], index) =>
        rightEntries[index]?.[0] === slug && rightEntries[index]?.[1] === fingerprint,
    )
  );
}

function communitySummaryChildren(
  community: { children?: string[] },
  communitiesBySlug: ReadonlyMap<string, ExistingGeneratedCommunity>,
): Array<{ slug: string; title: string; members: string[]; summary: string }> | undefined {
  if (community.children === undefined || community.children.length === 0) {
    return undefined;
  }

  return [...community.children]
    .sort((left, right) => compareLocale(communitySlugFromReference(left), communitySlugFromReference(right)))
    .map((reference) => {
      const slug = communitySlugFromReference(reference);
      const child = communitiesBySlug.get(slug);
      if (child === undefined) {
        throw new Error(`Missing child community ${reference} while generating community summaries.`);
      }
      if (child.summary === undefined) {
        throw new Error(`Missing child summary for ${reference} while generating parent community summaries.`);
      }

      return {
        slug: child.slug,
        title: child.title,
        members: child.members,
        summary: child.summary,
      };
    });
}

function toExistingGeneratedCommunity(document: {
  slug: string;
  title: string;
  level: number;
  members: string[];
  parent?: string;
  children?: string[];
  summary?: string;
  createdAt: string;
  updatedAt: string;
}): ExistingGeneratedCommunity {
  return {
    slug: document.slug,
    title: document.title,
    level: document.level,
    members: document.members,
    ...(document.parent === undefined ? {} : { parent: document.parent }),
    ...(document.children === undefined ? {} : { children: document.children }),
    ...(document.summary === undefined ? {} : { summary: document.summary }),
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

export async function runCommunitySubphase(
  kb: KbRuntime,
  spawnCli: SpawnCliFn,
  options: RunCommunitySubphaseOptions = {},
): Promise<boolean> {
  const { signal, shouldStop = () => false } = options;
  let wroteCommunityFiles = false;

  await kb.withMutationLock(async () => {
    if (shouldStop() || signal?.aborted) {
      return;
    }

    const today = nowIsoString().slice(0, 10);
    const state = readCurateState(kb);
    const finalIndex = kb.readIndexOrEmpty();
    const graph = buildEntityRelationshipGraph({
      entityMeta: finalIndex.entityMeta ?? {},
      relationships: finalIndex.relationships ?? [],
    });
    const topologyHash = computeCommunityTopologyFingerprint(finalIndex, graph);
    const topologyNeedsRefresh = state.communityTopologyHash !== topologyHash;
    const { generated: priorGeneratedCommunities, reservedSlugs } = loadExistingCommunityState(kb);

    let activeCommunities = [...priorGeneratedCommunities];
    let pendingArtifactRebuild = false;
    let summaryStateChanged = false;
    const recordCommunityMutation = () => {
      recordMetadataMutation(kb, CURATE_STALE_REASON);
      pendingArtifactRebuild = true;
    };

    if (topologyNeedsRefresh) {
      const communities = detectCommunities(graph, {
        priorCommunities: priorGeneratedCommunities,
        reservedSlugs,
      });
      const communityDocuments = buildCommunityDocuments(communities, {
        priorGeneratedCommunities,
        today,
      });

      if (generateCommunityFiles(kb, communityDocuments, priorGeneratedCommunities, recordCommunityMutation)) {
        wroteCommunityFiles = true;
      }

      activeCommunities = communityDocuments.map(toExistingGeneratedCommunity);
    }

    let currentState = topologyNeedsRefresh ? readCurateState(kb) : state;
    let summaryInputFingerprints = {
      ...(normalizedCommunitySummaryFingerprints(currentState.communitySummaryInputFingerprints, activeCommunities) ?? {}),
    };
    const normalizedFingerprints =
      Object.keys(summaryInputFingerprints).length === 0 ? undefined : summaryInputFingerprints;
    const initialSummaryStateChange =
      currentState.communityTopologyHash !== topologyHash ||
      currentState.communitySummaryTopologyHash !== topologyHash ||
      !sameCommunitySummaryFingerprints(currentState.communitySummaryInputFingerprints, normalizedFingerprints);
    if (initialSummaryStateChange) {
      writeCurateState(kb, {
        ...currentState,
        communityTopologyHash: topologyHash,
        communitySummaryTopologyHash: topologyHash,
        communitySummaryInputFingerprints: normalizedFingerprints,
      });
      summaryStateChanged = true;
    }

    if (pendingArtifactRebuild || (topologyNeedsRefresh && summaryStateChanged)) {
      const rebuildState = kb.readIndexState();
      await rebuildTextArtifactsAndPersistRepairState(kb, {
        contentSeq: rebuildState.contentSeq,
        metadataSeq: rebuildState.metadataSeq,
      });
      pendingArtifactRebuild = false;
      summaryStateChanged = false;
    }

    const communitiesBySlug = new Map(activeCommunities.map((community) => [community.slug, community] as const));
    for (const community of [...activeCommunities].sort((left, right) => {
      if (left.level !== right.level) {
        return left.level - right.level;
      }
      return compareLocale(left.slug, right.slug);
    })) {
      if (shouldStop() || signal?.aborted) {
        break;
      }

      const summaryInputFingerprint = computeCommunitySummaryInputFingerprintForCommunity(
        community,
        communitiesBySlug,
        kb,
        finalIndex,
      );
      const currentSummaryFingerprint = summaryInputFingerprints[community.slug];

      if (community.summary === undefined || currentSummaryFingerprint !== summaryInputFingerprint) {
        const summary = await generateCommunitySummary({
          community: {
            slug: community.slug,
            title: community.title,
            level: community.level,
            members: community.members,
            ...(community.parent === undefined ? {} : { parent: community.parent }),
            ...(community.children === undefined ? {} : { children: community.children }),
          },
          kb,
          index: finalIndex,
          childCommunities: communitySummaryChildren(community, communitiesBySlug),
          priorCommunity: community,
          priorSummaryInputFingerprint: currentSummaryFingerprint,
          runClaude(prompt, extraArgs, summarySignal) {
            return runCurateClaude(kb, spawnCli, prompt, extraArgs, summarySignal);
          },
          signal,
        });

        if (summary !== community.summary) {
          const updatedCommunity: ExistingGeneratedCommunity = {
            ...community,
            ...(summary === undefined ? {} : { summary }),
            updatedAt: today,
          };
          writeFileAtomic(
            kb.communityPath(updatedCommunity.slug),
            renderCommunityDocument({
              title: updatedCommunity.title,
              members: updatedCommunity.members,
              level: updatedCommunity.level,
              ...(updatedCommunity.parent === undefined ? {} : { parent: updatedCommunity.parent }),
              ...(updatedCommunity.children === undefined ? {} : { children: updatedCommunity.children }),
              ...(summary === undefined ? {} : { summary }),
              createdAt: updatedCommunity.createdAt,
              updatedAt: updatedCommunity.updatedAt,
            }),
          );
          recordCommunityMutation();
          wroteCommunityFiles = true;
          communitiesBySlug.set(updatedCommunity.slug, updatedCommunity);
        }
      }

      if (summaryInputFingerprints[community.slug] !== summaryInputFingerprint) {
        summaryInputFingerprints = {
          ...summaryInputFingerprints,
          [community.slug]: summaryInputFingerprint,
        };
        currentState = readCurateState(kb);
        writeCurateState(kb, {
          ...currentState,
          communityTopologyHash: topologyHash,
          communitySummaryTopologyHash: topologyHash,
          communitySummaryInputFingerprints: normalizedCommunitySummaryFingerprints(
            summaryInputFingerprints,
            activeCommunities,
          ),
        });
        summaryStateChanged = true;
      }
    }

    if (pendingArtifactRebuild || summaryStateChanged) {
      const rebuildState = kb.readIndexState();
      await rebuildTextArtifactsAndPersistRepairState(kb, {
        contentSeq: rebuildState.contentSeq,
        metadataSeq: rebuildState.metadataSeq,
      });
    }

    currentState = readCurateState(kb);
    writeCurateState(kb, {
      ...currentState,
      communityTopologyHash: topologyHash,
      communitySummaryTopologyHash: topologyHash,
      communitySummaryInputFingerprints: normalizedCommunitySummaryFingerprints(
        summaryInputFingerprints,
        activeCommunities,
      ),
    });
  });

  return wroteCommunityFiles;
}
