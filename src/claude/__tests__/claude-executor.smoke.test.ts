import { describe, it, expect } from 'vitest';
import { executeClaudeOneShot, executeClaudeResume } from '../claude-executor.js';

describe.skipIf(!process.env.CORAL_SMOKE_TEST)('claude-executor smoke', () => {
  it('runs one-shot execution using stdin prompt transport', async () => {
    const result = await executeClaudeOneShot('Reply with exactly: OK');

    expect(result.response.length).toBeGreaterThan(0);
  }, 120_000);

  it('supports --resume with --system-prompt', async () => {
    const first = await executeClaudeOneShot('Reply with exactly: READY');

    if (!first.sessionId) {
      expect(first.sessionId).toBeTruthy();
      return;
    }

    const resumed = await executeClaudeResume(first.sessionId, 'Reply with exactly: CONTINUE', {
      systemPrompt: 'You are a test assistant. Output exactly one token.',
    });

    expect(resumed.response.length).toBeGreaterThan(0);
  }, 120_000);
});
