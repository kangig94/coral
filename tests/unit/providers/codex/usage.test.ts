import { describe, expect, it } from 'vitest';

import { normalizeCodexUsage } from '#src/providers/codex/usage.js';

function sumCodexTokens(usage: NonNullable<ReturnType<typeof normalizeCodexUsage>>): number {
  return (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.outputTokens ?? 0);
}

describe('normalizeCodexUsage', () => {
  it('normalizes Codex cached input as a separate additive cache-read bucket', () => {
    const normalized = normalizeCodexUsage({
      totalTokens: 156_406,
      inputTokens: 155_699,
      cachedInputTokens: 142_720,
      outputTokens: 707,
      reasoningOutputTokens: 287,
    });

    expect(normalized).toEqual({
      inputTokens: 12_979,
      cacheReadTokens: 142_720,
      outputTokens: 707,
    });
    if (normalized === undefined) throw new Error('normalizeCodexUsage returned undefined');
    expect(sumCodexTokens(normalized)).toBe(156_406);
    expect(normalized).not.toHaveProperty('cacheWriteTokens');
    expect(normalized).not.toHaveProperty('costUsd');
  });

  it('clamps malformed cached input overage instead of producing negative fresh input', () => {
    expect(
      normalizeCodexUsage({
        inputTokens: 5,
        cachedInputTokens: 8,
        outputTokens: 1,
      }),
    ).toEqual({
      inputTokens: 0,
      cacheReadTokens: 8,
      outputTokens: 1,
    });
  });
});
