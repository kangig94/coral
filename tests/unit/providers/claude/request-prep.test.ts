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

describe('buildPreparedClaudeRequest KB gating', () => {
  type PrepArgs = Parameters<typeof buildPreparedClaudeRequest>;
  const INJECT_MD = 'Guidelines\n<!-- KB_ONLY:BEGIN -->\n# Knowledge Base\nkb stuff\n<!-- KB_ONLY:END -->';
  const storage = {
    readFileSync: (p: string) => (p.endsWith('INJECT.md') ? INJECT_MD : ''),
  } as unknown as PrepArgs[1];
  const requestWith = (coralEnv: Record<string, string>) => ({ prompt: 'hi', coralEnv }) as unknown as PrepArgs[0];

  it('omits KB guidance from the system prompt when coralEnv disables KB', () => {
    const result = buildPreparedClaudeRequest(requestWith({ CORAL_KB_ENABLE: '0' }), storage, '/mock/kb');
    expect(result.systemPrompt).toContain('Guidelines');
    expect(result.systemPrompt).not.toContain('kb stuff');
  });

  it('includes KB guidance when coralEnv enables KB', () => {
    const result = buildPreparedClaudeRequest(requestWith({ CORAL_KB_ENABLE: '1' }), storage, '/mock/kb');
    expect(result.systemPrompt).toContain('kb stuff');
  });
});
