import type { UsageSummary } from '../contract.js';

export type CodexTokenUsage = Record<string, unknown>;

function readNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function normalizeCodexUsage(tokenCount: CodexTokenUsage | null | undefined): UsageSummary | undefined {
  if (tokenCount === null || tokenCount === undefined) {
    return undefined;
  }

  const inputTokens = readNonnegativeInteger(tokenCount.inputTokens);
  const cachedInputTokens = readNonnegativeInteger(tokenCount.cachedInputTokens);
  const outputTokens = readNonnegativeInteger(tokenCount.outputTokens);

  if (inputTokens === undefined && cachedInputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }

  // Codex inputTokens (v2 TokenUsageBreakdown) is cumulative and includes
  // cachedInputTokens, so fresh input is input minus cached (clamped at zero),
  // unlike Claude's already disjoint token buckets.
  const freshInputTokens = Math.max((inputTokens ?? 0) - (cachedInputTokens ?? 0), 0);

  return {
    ...(inputTokens === undefined && cachedInputTokens === undefined ? {} : { inputTokens: freshInputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cacheReadTokens: cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}
