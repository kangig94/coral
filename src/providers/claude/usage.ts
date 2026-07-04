import { isRecord } from '../../infra/json.js';
import type { UsageSummary } from '../contract.js';

function readTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function normalizeClaudeUsage(rawUsage: unknown, costUsd?: number): UsageSummary | undefined {
  const usage: UsageSummary = {};

  if (isRecord(rawUsage)) {
    const inputTokens = readTokenCount(rawUsage.input_tokens);
    const cacheReadTokens = readTokenCount(rawUsage.cache_read_input_tokens);
    const cacheWriteTokens = readTokenCount(rawUsage.cache_creation_input_tokens);
    const outputTokens = readTokenCount(rawUsage.output_tokens);

    if (inputTokens !== undefined) {
      usage.inputTokens = inputTokens;
    }
    if (cacheReadTokens !== undefined) {
      usage.cacheReadTokens = cacheReadTokens;
    }
    if (cacheWriteTokens !== undefined) {
      usage.cacheWriteTokens = cacheWriteTokens;
    }
    if (outputTokens !== undefined) {
      usage.outputTokens = outputTokens;
    }
  }

  if (costUsd !== undefined) {
    usage.costUsd = costUsd;
  }

  return Object.keys(usage).length === 0 ? undefined : usage;
}
