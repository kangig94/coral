import { describe, expect, it } from 'vitest';

import { normalizeClaudeUsage } from '#src/providers/claude/usage.js';

describe('normalizeClaudeUsage', () => {
  it('maps a full Anthropic usage object into the canonical usage summary', () => {
    expect(
      normalizeClaudeUsage(
        {
          input_tokens: 11,
          cache_read_input_tokens: 13,
          cache_creation_input_tokens: 17,
          output_tokens: 19,
        },
        0.34,
      ),
    ).toEqual({
      inputTokens: 11,
      cacheReadTokens: 13,
      cacheWriteTokens: 17,
      outputTokens: 19,
      costUsd: 0.34,
    });
  });

  it('omits canonical fields whose raw Anthropic fields are absent', () => {
    expect(
      normalizeClaudeUsage({
        input_tokens: 23,
        output_tokens: 29,
      }),
    ).toEqual({
      inputTokens: 23,
      outputTokens: 29,
    });
  });

  it('returns a cost-only usage summary when only costUsd is known', () => {
    expect(normalizeClaudeUsage(undefined, 0.01)).toEqual({ costUsd: 0.01 });
  });
});
