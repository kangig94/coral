import { describe, expect, it } from 'vitest';

import { buildPreparedClaudeRequest, resolveClaudeModel } from '#src/providers/claude/request-prep.js';

describe('resolveClaudeModel', () => {
  it('returns undefined when CORAL_CLAUDE_MODEL is absent', () => {
    expect(resolveClaudeModel(undefined, {})).toBeUndefined();
  });

  it('returns undefined when CORAL_CLAUDE_MODEL is the empty string', () => {
    expect(resolveClaudeModel(undefined, { CORAL_CLAUDE_MODEL: '' })).toBeUndefined();
  });

  it('applies an in-cap abstract CORAL_CLAUDE_MODEL tier verbatim (the cappedDefault ?? envModel fallback)', () => {
    // resolveModelTier returns undefined for an in-cap abstract tier; the fallback re-applies it.
    expect(resolveClaudeModel(undefined, { CORAL_CLAUDE_MODEL: 'opus' })).toBe('opus');
    expect(resolveClaudeModel(undefined, { CORAL_CLAUDE_MODEL: 'sonnet' })).toBe('sonnet');
  });

  it('passes a specific model id through unchanged, including a [1m] context-variant suffix', () => {
    expect(resolveClaudeModel(undefined, { CORAL_CLAUDE_MODEL: 'claude-opus-4-8' })).toBe('claude-opus-4-8');
    // `opus[1m]` is not an abstract tier, so it is sent as-is (and is not tier-capped).
    expect(resolveClaudeModel(undefined, { CORAL_CLAUDE_MODEL: 'opus[1m]' })).toBe('opus[1m]');
    expect(resolveClaudeModel(undefined, { CORAL_CLAUDE_MODEL: 'opus[1m]', CORAL_CLAUDE_MODEL_CAP: 'sonnet' })).toBe(
      'opus[1m]',
    );
  });

  it('caps an over-cap CORAL_CLAUDE_MODEL default to CORAL_CLAUDE_MODEL_CAP', () => {
    expect(resolveClaudeModel(undefined, { CORAL_CLAUDE_MODEL: 'opus', CORAL_CLAUDE_MODEL_CAP: 'sonnet' })).toBe(
      'sonnet',
    );
  });

  it('prefers an explicit request model over CORAL_CLAUDE_MODEL', () => {
    expect(resolveClaudeModel('claude-custom', { CORAL_CLAUDE_MODEL: 'opus' })).toBe('claude-custom');
  });

  it('returns undefined for an in-cap abstract request model and never falls through to CORAL_CLAUDE_MODEL', () => {
    // A soft per-request tier defers to the provider...
    expect(resolveClaudeModel('sonnet', {})).toBeUndefined();
    expect(resolveClaudeModel('opus', { CORAL_CLAUDE_MODEL_CAP: 'opus' })).toBeUndefined();
    // ...and a present request model is never overridden by the env default (unlike Codex).
    expect(resolveClaudeModel('sonnet', { CORAL_CLAUDE_MODEL: 'opus' })).toBeUndefined();
  });
});

describe('buildPreparedClaudeRequest assembly', () => {
  it('puts pre-merged systemPrompt (INJECT) before agent instruction and style override', () => {
    const result = buildPreparedClaudeRequest({
      prompt: 'user task',
      coralEnv: {},
      systemPrompt: 'INJECT guidelines',
      instruction: { channel: 'system', content: 'agent body' },
    });
    expect(result.systemPrompt).toBe(
      [
        'INJECT guidelines',
        'agent body',
        'Ignore any output-style instructions (e.g. Explanatory, Learning). No insight blocks. Be concise and direct.',
      ].join('\n\n'),
    );
    expect(result.prompt).toBe('user task');
  });

  it('merges non-system instruction into the user prompt', () => {
    const result = buildPreparedClaudeRequest({
      prompt: 'user task',
      coralEnv: {},
      instruction: { channel: 'prompt', content: 'prefix' },
    });
    expect(result.prompt).toBe('prefix\n\n---\n\nuser task');
  });
});
