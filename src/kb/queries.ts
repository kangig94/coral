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
import type { MemoStorage } from './ops/memo.js';
import { buildKbDiagnoseResult } from './diagnose.js';
import {
  createDefaultKbQueryRuntime,
  createDefaultKbReadPaths,
  ensureBundledEnginesLoaded,
  getDefaultKbQueryDb,
  resolveQueryProjectRoot,
  type KbQueryContext,
} from './query-runtime.js';
import { readEntry } from './read.js';
import { readCurateRetryQueue } from './curate/retry.js';
import { listMemos } from './ops/memo.js';
import { listPrinciples } from './ops/principles-list.js';
import { searchKb } from './ops/search.js';
import { listSources } from './ops/source-store.js';

export async function searchKnowledgeBase(
  args: KbSearchInput,
  context: KbQueryContext,
): Promise<KbSearchResponse> {
  const kb = createDefaultKbQueryRuntime(context);
  await ensureBundledEnginesLoaded(kb, context);

  return await searchKb(kb, args.query, args.top_k ?? 20, args.scope ?? 'all', args.mode);
}

export function readKnowledgeBaseEntry(
  selector: KbReadInput,
  context: KbQueryContext,
): KbReadResult {
  const kb = createDefaultKbQueryRuntime(context);
  return readEntry(selector, {
    projectRoot: resolveQueryProjectRoot(context),
    storage: kb.storagePort,
    paths: createDefaultKbReadPaths(context),
  });
}

export async function listKnowledgeBasePrinciples(
  args: KbPrinciplesInput,
  context: KbQueryContext,
): Promise<KbPrinciplesResult> {
  const kb = createDefaultKbQueryRuntime(context);

  return listPrinciples(kb, args);
}

export async function listKnowledgeBaseSources(context: KbQueryContext): Promise<KbSourceListResult> {
  const kb = createDefaultKbQueryRuntime(context);

  return await listSources(kb);
}

export function diagnoseKnowledgeBase(context: KbQueryContext): KbDiagnoseResult {
  return buildKbDiagnoseResult(readCurateRetryQueue(getDefaultKbQueryDb(context)));
}

export function listKnowledgeBaseMemos(
  storage: MemoStorage,
  projectRoot: string,
  args: KbMemoListInput = {},
): KbMemoListResult {
  return listMemos(storage, projectRoot, args.owner);
}
