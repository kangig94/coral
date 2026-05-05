import type { KbRuntime } from '../contract.js';
import type { KbSearchResponse, KbSearchScope } from '../entry-types.js';
import type { KbSearchIntent } from '../search/query-planner.js';
import { createSearchRequest, runRetrieval } from './search-runner.js';

export async function searchKb(
  rt: KbRuntime,
  query: string,
  top_k = 20,
  scope: KbSearchScope = 'all',
  intent: KbSearchIntent = 'auto',
  signal?: AbortSignal,
): Promise<KbSearchResponse> {
  const request = createSearchRequest(query, top_k, scope, intent, signal);
  return runRetrieval(rt, request);
}
