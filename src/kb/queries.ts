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
import { buildKbDiagnoseResult } from './diagnose.js';
import {
  createDefaultKbQueryRuntime,
  createDefaultKbReadPaths,
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

  return await searchKb(kb, args.query, args.top_k ?? 20, args.scope ?? 'all', args.mode);
}

export function readKnowledgeBaseEntry(
  selector: KbReadInput,
  context: KbQueryContext,
): KbReadResult {
  return readEntry(selector, {
    projectRoot: resolveQueryProjectRoot(context),
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
  projectRoot: string,
  args: KbMemoListInput = {},
): KbMemoListResult {
  return listMemos(projectRoot, args.owner);
}
