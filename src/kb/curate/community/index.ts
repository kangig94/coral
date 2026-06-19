import { nowIsoString } from '../../../infra/time.js';
import type { KbCorpusSnapshot, KbRuntime } from '../../contract.js';
import { recordMetadataMutation } from '../../corpus/index-mutations.js';
import { compareLocale } from '../../validation.js';
import { communitySlugFromReference } from './identity.js';
import { buildCommunityPartitionTree } from './detection.js';
import {
  buildCommunityDocuments,
  generateCommunityFiles,
  loadExistingCommunityState,
  renderCommunityDocument,
} from './documents.js';
import { buildEntityRelationshipGraph } from './graph.js';
import { computeCommunitySummaryInputFingerprintForCommunity, generateCommunitySummary } from './summary.js';
import type { CommunityDocument, ExistingGeneratedCommunity } from './contracts.js';
import { CURATE_STALE_REASON, runCurateAssistant } from '../operations.js';
import { readCurateState, writeCurateState } from '../state/index.js';
import type { CurateAssistantPort } from '../assistant.js';
import { curateDb } from '../db-access.js';
import { readCurateConflictQuarantine } from '../conflict-quarantine.js';

export type RunCommunitySubphaseOptions = {
  signal?: AbortSignal;
  shouldStop?: () => boolean;
  onFreshnessMismatch?: () => void;
};

type CommunityPreparedPayload = {
  capturedBaselineSnapshot: KbCorpusSnapshot;
  capturedBaselineState: ReturnType<typeof readCurateState>;
  priorGeneratedCommunities: ExistingGeneratedCommunity[];
  reservedSlugs: Set<string>;
  generatedCommunityDocs: CommunityDocument[];
  quarantinedCommunitySlugs: Set<string>;
};

type PickedOptionalCommunityFields = {
  parent?: string;
  children?: string[];
  summary?: string;
  summaryInputFingerprint?: string;
  createdAt: string;
  updatedAt: string;
};

function pickOptionalCommunityFields(community: PickedOptionalCommunityFields): PickedOptionalCommunityFields {
  return {
    ...(community.parent === undefined ? {} : { parent: community.parent }),
    ...(community.children === undefined ? {} : { children: community.children }),
    ...(community.summary === undefined ? {} : { summary: community.summary }),
    ...(community.summaryInputFingerprint === undefined
      ? {}
      : { summaryInputFingerprint: community.summaryInputFingerprint }),
    createdAt: community.createdAt,
    updatedAt: community.updatedAt,
  };
}

function communitySummaryChildren(
  community: { children?: string[] },
  communitiesBySlug: ReadonlyMap<string, ExistingGeneratedCommunity>,
): Array<{ slug: string; title: string; members: string[]; summary: string }> | undefined {
  if (community.children === undefined || community.children.length === 0) {
    return undefined;
  }

  const childReferences = [...community.children].sort((left, right) =>
    compareLocale(communitySlugFromReference(left), communitySlugFromReference(right)),
  );
  const children: Array<{ slug: string; title: string; members: string[]; summary: string }> = [];
  for (const reference of childReferences) {
    const slug = communitySlugFromReference(reference);
    const child = communitiesBySlug.get(slug);
    if (child === undefined) {
      throw new Error(`Missing child community ${reference} while generating community summaries.`);
    }
    if (child.summary === undefined) {
      throw new Error(`Missing child summary for ${reference} while generating parent community summaries.`);
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

function toExistingGeneratedCommunity(document: {
  slug: string;
  title: string;
  level: number;
  members: string[];
  parent?: string;
  children?: string[];
  summary?: string;
  summaryInputFingerprint?: string;
  createdAt: string;
  updatedAt: string;
}): ExistingGeneratedCommunity {
  return {
    slug: document.slug,
    title: document.title,
    level: document.level,
    members: document.members,
    ...pickOptionalCommunityFields(document),
  };
}

function renderExistingCommunityDocument(
  community: ExistingGeneratedCommunity,
): CommunityDocument {
  return {
    slug: community.slug,
    title: community.title,
    level: community.level,
    members: community.members,
    ...pickOptionalCommunityFields(community),
    content: renderCommunityDocument({
      title: community.title,
      members: community.members,
      level: community.level,
      ...pickOptionalCommunityFields(community),
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
  curateAssistant: CurateAssistantPort,
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
  const partitionTree = buildCommunityPartitionTree(graph);
  const { generated: priorGeneratedCommunities, reservedSlugs } = loadExistingCommunityState(kb);
  const quarantinedCommunitySlugs = new Set<string>();
  for (const entry of readCurateConflictQuarantine(curateDb(kb))) {
    if (entry.kind === 'community') {
      quarantinedCommunitySlugs.add(entry.slug);
    }
  }

  const detectedCommunities = partitionTree.detect({
    priorCommunities: priorGeneratedCommunities,
    reservedSlugs,
  });
  const initialCommunityDocs = buildCommunityDocuments(detectedCommunities, {
    priorGeneratedCommunities,
    today,
  });

  const activeCommunities: ExistingGeneratedCommunity[] = [];
  const communitiesBySlug = new Map<string, ExistingGeneratedCommunity>();
  for (const document of initialCommunityDocs) {
    const community = toExistingGeneratedCommunity(document);
    activeCommunities.push(community);
    communitiesBySlug.set(community.slug, community);
  }

  for (const community of [...activeCommunities].sort((left, right) => {
    if (left.level !== right.level) {
      return left.level - right.level;
    }
    return compareLocale(left.slug, right.slug);
  })) {
    if (shouldStop() || signal?.aborted) {
      return null;
    }
    if (quarantinedCommunitySlugs.has(community.slug)) {
      continue;
    }

    const summaryInputFingerprint = computeCommunitySummaryInputFingerprintForCommunity(
      community,
      communitiesBySlug,
      kb,
      capturedFinalIndex,
    );
    // The freshness gate reads `summaryInputFingerprint` from the community
    // markdown frontmatter (via the index), NOT from the local curate DB. This
    // is deliberate: the KB corpus syncs across machines over git, so the
    // freshness state must travel WITH the content. A DB-local fingerprint
    // would not propagate — each machine would re-run this LLM summary on the
    // same unchanged input, and concurrent re-summaries would fight through git
    // merges. The DB table `kb_curate_community_summary_input_fingerprints` is
    // bookkeeping for topology-refresh only and is intentionally NOT the gate
    // authority (see curate.test.ts: a stale DB row does not trigger a re-run).
    const currentSummaryFingerprint = community.summaryInputFingerprint;
    let nextCommunity = communitiesBySlug.get(community.slug) ?? community;

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
        runClaude(prompt, summarySignal) {
          return runCurateAssistant(curateAssistant, prompt, 'community-summary', summarySignal);
        },
        signal,
      });

      nextCommunity = {
        ...community,
        ...(summary === undefined ? {} : { summary }),
        updatedAt: today,
      };
    }

    communitiesBySlug.set(community.slug, {
      ...nextCommunity,
      summaryInputFingerprint,
    });
  }

  const generatedCommunityDocs: CommunityDocument[] = [];
  const orderedCommunities = [...communitiesBySlug.values()].sort((left, right) =>
    compareLocale(left.slug, right.slug),
  );
  for (const community of orderedCommunities) {
    if (quarantinedCommunitySlugs.has(community.slug)) {
      continue;
    }
    generatedCommunityDocs.push(renderExistingCommunityDocument(community));
  }

  return {
    capturedBaselineSnapshot,
    capturedBaselineState,
    priorGeneratedCommunities,
    reservedSlugs,
    generatedCommunityDocs,
    quarantinedCommunitySlugs,
  };
}

export async function runCommunitySubphase(
  kb: KbRuntime,
  curateAssistant: CurateAssistantPort,
  options: RunCommunitySubphaseOptions = {},
): Promise<boolean> {
  const prepared = await prepareCommunityPayload(kb, curateAssistant, options);
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
      consecutiveCommunityBatchFailures: 0,
      // A successful community batch implicitly clears the lane-disabled stamp
      // (the lane was unblocked); see scheduler.ts INVARIANT.MAX_CONSECUTIVE_FAILURES.
      communityBatchLaneDisabledAt: null,
    };
    const shouldWriteState =
      prepared.capturedBaselineState.consecutiveCommunityBatchFailures !== 0 ||
      prepared.capturedBaselineState.communityBatchLaneDisabledAt !== null;

    const writablePriorCommunities = prepared.priorGeneratedCommunities.filter(
      (community) => !prepared.quarantinedCommunitySlugs.has(community.slug),
    );
    if (generateCommunityFiles(kb, mutation, prepared.generatedCommunityDocs, writablePriorCommunities)) {
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
