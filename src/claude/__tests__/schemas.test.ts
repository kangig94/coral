import { describe, it, expect } from 'vitest';
import { claudeOpSchema, coralClaudeSchema } from '../schemas.js';

describe('claude schemas', () => {
  it('validates exec op with optional fields', () => {
    const parsed = claudeOpSchema.safeParse({
      op: 'exec',
      prompt: 'hello',
      session: 'session-ref',
      name: 'my-session',
      model: 'claude-3-5-sonnet',
      working_directory: '/tmp/work',
      system_prompt: 'Be strict',
    });

    expect(parsed.success).toBe(true);
  });

  it('validates list op with strict shape', () => {
    expect(claudeOpSchema.safeParse({ op: 'list' }).success).toBe(true);
    expect(claudeOpSchema.safeParse({ op: 'list', extra: true }).success).toBe(false);
  });

  it('validates wait op with timeout bounds', () => {
    const ok = claudeOpSchema.safeParse({
      op: 'wait',
      sessions: ['12345678-1234-4234-8234-123456789abc'],
      timeout_seconds: 120,
    });
    const bad = claudeOpSchema.safeParse({
      op: 'wait',
      sessions: ['12345678-1234-4234-8234-123456789abc'],
      timeout_seconds: 5000,
    });

    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });

  it('validates abort op session uuid', () => {
    expect(claudeOpSchema.safeParse({
      op: 'abort',
      session: '12345678-1234-4234-8234-123456789abc',
    }).success).toBe(true);

    expect(claudeOpSchema.safeParse({ op: 'abort', session: 'not-a-uuid' }).success).toBe(false);
  });

  it('validates coral:<name> schema and rejects traversal-like names', () => {
    const ok = coralClaudeSchema.safeParse({
      op: 'coral:architect',
      prompt: 'Do it',
    });
    const bad = coralClaudeSchema.safeParse({
      op: 'coral:../architect',
      prompt: 'Do it',
    });

    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });
});
