import { describe, it, expect } from 'vitest';
import { claudeOpSchema, coralClaudeSchema } from '../schemas.js';

describe('claude schemas', () => {
  it('validates exec op with optional fields', () => {
    const parsed = claudeOpSchema.safeParse({
      op: 'exec',
      prompt: 'hello',
      session: 'session-ref',
      work_dir: '/tmp/work',
    });

    expect(parsed.success).toBe(true);
  });

  it('validates list op with strict shape', () => {
    expect(claudeOpSchema.safeParse({ op: 'list' }).success).toBe(true);
    expect(claudeOpSchema.safeParse({ op: 'list', extra: true }).success).toBe(false);
  });

  it('rejects wait op discriminator', () => {
    const parsed = claudeOpSchema.safeParse({
      op: 'wait',
      sessions: ['12345678-1234-4234-8234-123456789abc'],
      timeout_seconds: 120,
    });
    expect(parsed.success).toBe(false);
  });

  it('validates fork op with session and optional fields', () => {
    const parsed = claudeOpSchema.safeParse({
      op: 'fork',
      session: 'base-session-ref',
      work_dir: '/tmp',
    });
    expect(parsed.success).toBe(true);
  });

  it('fork requires session field', () => {
    expect(claudeOpSchema.safeParse({ op: 'fork' }).success).toBe(false);
  });

  it('rejects abort discriminator (removed — use unified abort tool)', () => {
    expect(claudeOpSchema.safeParse({
      op: 'abort',
      session: '12345678-1234-4234-8234-123456789abc',
    }).success).toBe(false);
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

  it('validates coral schema with work_dir', () => {
    expect(coralClaudeSchema.safeParse({
      op: 'coral:architect',
      prompt: 'Do it',
      work_dir: '/tmp',
    }).success).toBe(true);
  });

  it('accepts optional owner field with valid token-safe value', () => {
    const result = coralClaudeSchema.safeParse({
      op: 'coral:architect',
      prompt: 'Do it',
      owner: 'session-abc.123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.owner).toBe('session-abc.123');
    }
  });

  it('accepts missing owner field', () => {
    const result = coralClaudeSchema.safeParse({
      op: 'coral:architect',
      prompt: 'Do it',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.owner).toBeUndefined();
    }
  });

  it('rejects owner with invalid characters', () => {
    expect(coralClaudeSchema.safeParse({
      op: 'coral:architect',
      prompt: 'Do it',
      owner: '../bad',
    }).success).toBe(false);
  });

  it('rejects empty string owner', () => {
    expect(coralClaudeSchema.safeParse({
      op: 'coral:architect',
      prompt: 'Do it',
      owner: '',
    }).success).toBe(false);
  });

});
