import type {
  KbDiagnoseResult,
  KbMemoListInput,
  KbMemoListResult,
  KbPrinciplesInput,
  KbPrinciplesResult,
  KbReadInput,
  KbReadResult,
  KbSearchInput,
  KbSearchResponse,
  KbSourceListResult,
  KbWakeUpInput,
  KbWakeUpResponse,
  KbWikiListResult,
} from './entry-types.js';
import { type MemoStorage, listMemos } from './ops/memo.js';
import { buildKbDiagnoseResult } from './diagnose.js';
import type { KbRuntime } from './contract.js';
import type { ReadonlyDatabase } from '../store/read-port.js';
import {
  readEntry,
  readEntryWithResolvedId,
  type KbReadPathResolver,
  type KbReadStorage,
  type KbResolvedReadResult,
} from './read.js';
import { readCurateRetryQueue } from './curate/retry.js';
import { listPrinciples } from './ops/principles-list.js';
import { searchKb } from './ops/search.js';
import { listSources } from './ops/source-store.js';
import { listWikis } from './ops/wiki/list.js';
import { generateWakeUpPacket } from './ops/wake-up.js';

/**
 * Composed dependencies a KB read query needs. The KB domain declares this
 * contract; composition (caching, runtime construction, bundled-engine
 * loading) lives in `read-model/kb-query-runtime.ts`. Domains do not
 * compose runtimes — they receive a ready host through this interface.
 */
export interface KbQueryHost {
  /**
   * Returns a `KbRuntime` ready for read queries. When `ensureBundledEngines`
   * is true, bundled read-side engines (orama base projection etc.) are
   * loaded onto the runtime before return — search needs this; metadata
   * reads do not.
   */
  acquireKbRuntime(options?: { ensureBundledEngines?: boolean }): Promise<KbRuntime>;
  readonly readDb: ReadonlyDatabase;
  readonly storage: KbReadStorage;
  readonly readPaths: KbReadPathResolver;
  /** Resolved per-project data dir for the caller's project root (memo reads/writes). */
  requireProjectDataDir(operation: string): string;
}

export async function searchKnowledgeBase(args: KbSearchInput, host: KbQueryHost): Promise<KbSearchResponse> {
  const kb = await host.acquireKbRuntime({ ensureBundledEngines: true });
  return searchKb(kb, args.query, args.top_k ?? 20, args.scope ?? 'all', args.mode ?? 'auto', args.signal);
}

export function readKnowledgeBaseEntry(selector: KbReadInput, host: KbQueryHost): KbReadResult {
  return readEntry(selector, {
    projectDataDir: host.requireProjectDataDir('kb.read'),
    storage: host.storage,
    paths: host.readPaths,
  });
}

export function readKnowledgeBaseEntryWithResolvedId(selector: KbReadInput, host: KbQueryHost): KbResolvedReadResult {
  return readEntryWithResolvedId(selector, {
    projectDataDir: host.requireProjectDataDir('kb.read'),
    storage: host.storage,
    paths: host.readPaths,
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

export function diagnoseKnowledgeBase(host: KbQueryHost): KbDiagnoseResult {
  return buildKbDiagnoseResult(readCurateRetryQueue(host.readDb));
}

export function listKnowledgeBaseMemos(
  storage: MemoStorage,
  projectDataDir: string,
  args: KbMemoListInput = {},
): KbMemoListResult {
  return listMemos(storage, projectDataDir, args.owner);
}
