import { nowIsoString } from '../../../infra/time.js';
import type { KbCorpusSnapshot, KbRuntime } from '../../contract.js';
import { recordMetadataMutation } from '../../corpus/index-mutations.js';
import { compareLocale } from '../../validation.js';
import { communitySlugFromReference } from './identity.js';
import { computeCommunityTopologyFingerprint, detectCommunities } from './detection.js';
import { normalizedCommunitySummaryFingerprints } from './topology-refresh.js';
import {
  buildCommunityDocuments,
  generateCommunityFiles,
  loadExistingCommunityState,
  renderCommunityDocument,
} from './documents.js';
import { buildEntityRelationshipGraph } from './graph.js';
import { computeCommunitySummaryInputFingerprintForCommunity, generateCommunitySummary } from './summary.js';
import type { CommunityDocument, ExistingGeneratedCommunity } from './contracts.js';
import { CURATE_STALE_REASON, runCurateClaude } from '../operations.js';
import { readCurateState, writeCurateState } from '../state/index.js';
import type { SpawnCliFn } from '../spawn-cli.js';
import { curateDb } from '../db-access.js';

export type RunCommunitySubphaseOptions = {
  signal?: AbortSignal;
  shouldStop?: () => boolean;
  onFreshnessMismatch?: () => void;
};

type CommunityPreparedPayload = {
  capturedBaselineSnapshot: KbCorpusSnapshot;
  capturedBaselineState: ReturnType<typeof readCurateState>;
  capturedBaselineSummaryFingerprints: Record<string, string> | undefined;
  priorGeneratedCommunities: ExistingGeneratedCommunity[];
  reservedSlugs: Set<string>;
  generatedCommunityDocs: CommunityDocument[];
  summaryFingerprints: Record<string, string> | undefined;
  topologyHash: string;
};

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

function renderExistingCommunityDocument(community: ExistingGeneratedCommunity): CommunityDocument {
  return {
    slug: community.slug,
    title: community.title,
    level: community.level,
    members: community.members,
    ...(community.parent === undefined ? {} : { parent: community.parent }),
    ...(community.children === undefined ? {} : { children: community.children }),
    ...(community.summary === undefined ? {} : { summary: community.summary }),
    createdAt: community.createdAt,
    updatedAt: community.updatedAt,
    content: renderCommunityDocument({
      title: community.title,
      members: community.members,
      level: community.level,
      ...(community.parent === undefined ? {} : { parent: community.parent }),
      ...(community.children === undefined ? {} : { children: community.children }),
      ...(community.summary === undefined ? {} : { summary: community.summary }),
      createdAt: community.createdAt,
      updatedAt: community.updatedAt,
    }),
  };
}

function sameSnapshot(left: KbCorpusSnapshot, right: KbCorpusSnapshot): boolean {
  return (
    left.snapshotId === right.snapshotId &&
    left.contentSeq === right.contentSeq &&
    left.metadataSeq === right.metadataSeq &&
    left.contentManifestHash === right.contentManifestHash &&
    left.metadataManifestHash === right.metadataManifestHash
  );
}

async function prepareCommunityPayload(
  kb: KbRuntime,
  spawnCli: SpawnCliFn,
  options: RunCommunitySubphaseOptions,
): Promise<CommunityPreparedPayload | null> {
  const { signal, shouldStop = () => false } = options;
  if (shouldStop() || signal?.aborted) {
    return null;
  }

  const today = nowIsoString(kb.time).slice(0, 10);
  const capturedBaselineSnapshot = kb.captureCorpusSnapshot();
  const capturedBaselineState = readCurateState(curateDb(kb));
  const capturedFinalIndex = kb.readIndexOrEmpty();
  const graph = buildEntityRelationshipGraph({
    entityMeta: capturedFinalIndex.entityMeta,
    relationships: capturedFinalIndex.relationships,
  });
  const topologyHash = computeCommunityTopologyFingerprint(capturedFinalIndex, graph);
  const { generated: priorGeneratedCommunities, reservedSlugs } = loadExistingCommunityState(kb);

  const detectedCommunities = detectCommunities(graph, {
    priorCommunities: priorGeneratedCommunities,
    reservedSlugs,
  });
  const initialCommunityDocs =
    capturedBaselineState.communityTopologyHash !== topologyHash
      ? buildCommunityDocuments(detectedCommunities, {
          priorGeneratedCommunities,
          today,
        })
      : priorGeneratedCommunities.map(renderExistingCommunityDocument);

  const activeCommunities = initialCommunityDocs.map(toExistingGeneratedCommunity);
  const communitiesBySlug = new Map(activeCommunities.map((community) => [community.slug, community] as const));
  const capturedBaselineSummaryFingerprints = normalizedCommunitySummaryFingerprints(
    capturedBaselineState.communitySummaryInputFingerprints,
    activeCommunities,
  );
  let summaryInputFingerprints = {
    ...(capturedBaselineSummaryFingerprints ?? {}),
  };

  for (const community of [...activeCommunities].sort((left, right) => {
    if (left.level !== right.level) {
      return left.level - right.level;
    }
    return compareLocale(left.slug, right.slug);
  })) {
    if (shouldStop() || signal?.aborted) {
      return null;
    }

    const summaryInputFingerprint = computeCommunitySummaryInputFingerprintForCommunity(
      community,
      communitiesBySlug,
      kb,
      capturedFinalIndex,
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
        index: capturedFinalIndex,
        childCommunities: communitySummaryChildren(community, communitiesBySlug),
        priorCommunity: community,
        priorSummaryInputFingerprint: currentSummaryFingerprint,
        runClaude(prompt, extraArgs, summarySignal) {
          return runCurateClaude(kb, spawnCli, prompt, extraArgs, summarySignal);
        },
        signal,
      });

      communitiesBySlug.set(community.slug, {
        ...community,
        ...(summary === undefined ? {} : { summary }),
        updatedAt: today,
      });
    }

    summaryInputFingerprints = {
      ...summaryInputFingerprints,
      [community.slug]: summaryInputFingerprint,
    };
  }

  const generatedCommunityDocs = [...communitiesBySlug.values()]
    .sort((left, right) => compareLocale(left.slug, right.slug))
    .map(renderExistingCommunityDocument);

  return {
    capturedBaselineSnapshot,
    capturedBaselineState,
    capturedBaselineSummaryFingerprints,
    priorGeneratedCommunities,
    reservedSlugs,
    generatedCommunityDocs,
    summaryFingerprints: normalizedCommunitySummaryFingerprints(summaryInputFingerprints, generatedCommunityDocs),
    topologyHash,
  };
}

export async function runCommunitySubphase(
  kb: KbRuntime,
  spawnCli: SpawnCliFn,
  options: RunCommunitySubphaseOptions = {},
): Promise<boolean> {
  const prepared = await prepareCommunityPayload(kb, spawnCli, options);
  if (prepared === null) {
    return false;
  }

  const { signal, shouldStop = () => false, onFreshnessMismatch } = options;
  let wroteCommunityFiles = false;

  await kb.withMutationLock(async (mutation) => {
    if (shouldStop() || signal?.aborted) {
      return;
    }

    const currentSnapshot = kb.captureCorpusSnapshot();
    if (!sameSnapshot(prepared.capturedBaselineSnapshot, currentSnapshot)) {
      onFreshnessMismatch?.();
      return;
    }

    const nextState = {
      ...prepared.capturedBaselineState,
      communityTopologyHash: prepared.topologyHash,
      communitySummaryTopologyHash: prepared.topologyHash,
      communitySummaryInputFingerprints: prepared.summaryFingerprints,
      consecutiveCommunityBatchFailures: 0,
      // A successful community batch implicitly clears the lane-disabled stamp
      // (the lane was unblocked); see scheduler.ts INVARIANT.MAX_CONSECUTIVE_FAILURES.
      communityBatchLaneDisabledAt: null,
    };
    const shouldWriteState =
      prepared.capturedBaselineState.communityTopologyHash !== nextState.communityTopologyHash ||
      prepared.capturedBaselineState.communitySummaryTopologyHash !== nextState.communitySummaryTopologyHash ||
      JSON.stringify(prepared.capturedBaselineSummaryFingerprints ?? {}) !==
        JSON.stringify(nextState.communitySummaryInputFingerprints ?? {}) ||
      prepared.capturedBaselineState.consecutiveCommunityBatchFailures !== 0 ||
      prepared.capturedBaselineState.communityBatchLaneDisabledAt !== null;

    if (generateCommunityFiles(kb, mutation, prepared.generatedCommunityDocs, prepared.priorGeneratedCommunities)) {
      wroteCommunityFiles = true;
    }
    if (shouldWriteState) {
      writeCurateState(curateDb(kb), nextState);
    }

    if (wroteCommunityFiles || shouldWriteState) {
      recordMetadataMutation(kb, CURATE_STALE_REASON);
    }
  });

  return wroteCommunityFiles;
}
