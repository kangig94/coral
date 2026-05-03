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
} from './entry-types.js';
import { type MemoStorage, listMemos } from './ops/memo.js';
import { buildKbDiagnoseResult } from './diagnose.js';
import type { KbRuntime } from './contract.js';
import type { ReadonlyDatabase } from '../store/read-port.js';
import { readEntry, type KbReadPathResolver, type KbReadStorage } from './read.js';
import { readCurateRetryQueue } from './curate/retry.js';
import { listPrinciples } from './ops/principles-list.js';
import { searchKb } from './ops/search.js';
import { listSources } from './ops/source-store.js';

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
  /** Some operations require a project root; the host provides it when the caller specified one. */
  requireProjectRoot(operation: string): string;
}

export async function searchKnowledgeBase(args: KbSearchInput, host: KbQueryHost): Promise<KbSearchResponse> {
  const kb = await host.acquireKbRuntime({ ensureBundledEngines: true });
  return await searchKb(kb, args.query, args.top_k ?? 20, args.scope ?? 'all', args.mode ?? 'auto', args.signal);
}

export function readKnowledgeBaseEntry(selector: KbReadInput, host: KbQueryHost): KbReadResult {
  return readEntry(selector, {
    projectRoot: host.requireProjectRoot('kb.read'),
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
  return await listSources(kb);
}

export function diagnoseKnowledgeBase(host: KbQueryHost): KbDiagnoseResult {
  return buildKbDiagnoseResult(readCurateRetryQueue(host.readDb));
}

export function listKnowledgeBaseMemos(
  storage: MemoStorage,
  projectRoot: string,
  args: KbMemoListInput = {},
): KbMemoListResult {
  return listMemos(storage, projectRoot, args.owner);
}
