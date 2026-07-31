import type {
  KbDiagnoseResult,
  KbMemoListInput,
  KbMemoListResult,
  KbPrinciplesInput,
  KbPrinciplesResult,
  KbReadInput,
  KbReadResult,
  KbSourceListResult,
  KbWakeUpInput,
  KbWakeUpResponse,
  KbWikiListResult,
} from './entry-types.js';
import { type MemoStorage, listMemos } from './ops/memo.js';
import { buildKbDiagnoseResult } from './diagnose.js';
import type { KbReadQueryRuntime } from './contract.js';
import type { ReadonlyDatabase } from '../store/read-port.js';
import {
  readEntry,
  readEntryWithResolvedId,
  type KbReadPathResolver,
  type KbReadCommunityDocumentProvider,
  type KbReadStorage,
  type KbResolvedReadResult,
} from './read.js';
import { readCurateRetryQueue } from './curate/retry.js';
import { readCurateConflictQuarantine } from './curate/conflict-quarantine.js';
import { listPrinciples } from './ops/principles-list.js';
import { listSources } from './ops/source/store.js';
import { listWikis } from './ops/wiki/list.js';
import { generateWakeUpPacket } from './ops/wake-up.js';
import {
  listStaleCommunities,
  readCommunitySummaryInput,
  type CommunitySummaryInput,
  type StaleCommunity,
} from './curate/community/summary-surface.js';

/**
 * Composed dependencies a KB read query needs. The KB domain declares this
 * contract; direct-read composition (caching and runtime construction) lives
 * in `read-model/kb-query-runtime.ts`. Domains do not compose runtimes — they
 * receive a ready host through this interface.
 */
export interface KbQueryHost {
  acquireKbRuntime(): Promise<KbReadQueryRuntime>;
  readonly readDb: ReadonlyDatabase;
  readonly storage: KbReadStorage;
  readonly readPaths: KbReadPathResolver;
  readonly communityDocumentProvider: KbReadCommunityDocumentProvider;
  /** Resolved per-project data dir for the caller's project root (memo reads/writes). */
  requireProjectDataDir(operation: string): string;
}

export function readKnowledgeBaseEntry(selector: KbReadInput, host: KbQueryHost): KbReadResult {
  return readEntry(selector, {
    projectDataDir: host.requireProjectDataDir('kb.read'),
    storage: host.storage,
    paths: host.readPaths,
    communityDocumentProvider: host.communityDocumentProvider,
  });
}

export function readKnowledgeBaseEntryWithResolvedId(selector: KbReadInput, host: KbQueryHost): KbResolvedReadResult {
  return readEntryWithResolvedId(selector, {
    projectDataDir: host.requireProjectDataDir('kb.read'),
    storage: host.storage,
    paths: host.readPaths,
    communityDocumentProvider: host.communityDocumentProvider,
  });
}

export async function listKnowledgeBasePrinciples(
  args: KbPrinciplesInput,
  host: KbQueryHost,
): Promise<KbPrinciplesResult> {
  const kb = await host.acquireKbRuntime();
  return listPrinciples(kb, args);
}

export async function listKnowledgeBaseSources(host: KbQueryHost): Promise<KbSourceListResult> {
  const kb = await host.acquireKbRuntime();
  return listSources(kb);
}

export async function listKnowledgeBaseWikis(host: KbQueryHost): Promise<KbWikiListResult> {
  const kb = await host.acquireKbRuntime();
  return { wikis: await listWikis(kb) };
}

export async function generateKnowledgeBaseWakeUpPacket(
  args: KbWakeUpInput,
  host: KbQueryHost,
): Promise<KbWakeUpResponse> {
  const kb = await host.acquireKbRuntime();
  return { content: await generateWakeUpPacket(kb, args.project) };
}

export async function listKnowledgeBaseStaleCommunities(host: KbQueryHost): Promise<StaleCommunity[]> {
  return listStaleCommunities(await host.acquireKbRuntime());
}

export async function readKnowledgeBaseCommunitySummaryInput(
  slug: string,
  host: KbQueryHost,
): Promise<CommunitySummaryInput | null> {
  return readCommunitySummaryInput(await host.acquireKbRuntime(), slug);
}

export function diagnoseKnowledgeBase(host: KbQueryHost): KbDiagnoseResult {
  return buildKbDiagnoseResult(readCurateRetryQueue(host.readDb), readCurateConflictQuarantine(host.readDb));
}

export function listKnowledgeBaseMemos(
  storage: MemoStorage,
  projectDataDir: string,
  args: KbMemoListInput = {},
): KbMemoListResult {
  return listMemos(storage, projectDataDir, args.owner);
}
