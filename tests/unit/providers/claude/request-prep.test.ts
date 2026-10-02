import { describe, expect, it } from 'vitest';

import { resolveClaudeModel } from '#src/providers/claude/request-prep.js';

describe('resolveClaudeModel', () => {
  it('should cap an over-cap abstract request tier without consulting CORAL_CLAUDE_MODEL', () => {
    expect(resolveClaudeModel('fable', { CORAL_CLAUDE_MODEL_CAP: 'opus' })).toBe('opus');
    expect(resolveClaudeModel('fable', { CORAL_CLAUDE_MODEL_CAP: 'sonnet', CORAL_CLAUDE_MODEL: 'haiku' })).toBe(
      'sonnet',
    );
  });
});
