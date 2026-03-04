import { describe, it, expect } from 'vitest';
import { claudeOpSchema, coralClaudeSchema } from '../schemas.js';

function expectExecBypassValue(input: Record<string, unknown>, expected: boolean): void {
  const parsed = claudeOpSchema.parse({ op: 'exec', prompt: 'hello', ...input });
  expect(parsed.op).toBe('exec');
  if (parsed.op === 'exec') expect(parsed.bypass).toBe(expected);
}

function expectCoralBypassValue(input: Record<string, unknown>, expected: boolean): void {
  const parsed = coralClaudeSchema.parse({ op: 'coral:architect', prompt: 'Do it', ...input });
  expect(parsed.bypass).toBe(expected);
}

describe('claude schemas', () => {
  it('validates exec op with optional fields', () => {
    const parsed = claudeOpSchema.safeParse({
      op: 'exec',
      prompt: 'hello',
      session: 'session-ref',
      name: 'my-session',
      model: 'claude-3-5-sonnet',
      working_directory: '/tmp/work',
      effort: 'high',
      system_prompt: 'Be strict',
    });

    expect(parsed.success).toBe(true);
  });

  it('defaults exec bypass to false when omitted', () => {
    expectExecBypassValue({}, false);
  });

  it('preserves explicit exec bypass true', () => {
    expectExecBypassValue({ bypass: true }, true);
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
      effort: 'xhigh',
    });
    const bad = coralClaudeSchema.safeParse({
      op: 'coral:../architect',
      prompt: 'Do it',
    });

    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });

  it('accepts effort enum values including xhigh', () => {
    expect(claudeOpSchema.safeParse({
      op: 'exec',
      prompt: 'hello',
      effort: 'xhigh',
    }).success).toBe(true);

    expect(coralClaudeSchema.safeParse({
      op: 'coral:architect',
      prompt: 'Do it',
      effort: 'xhigh',
    }).success).toBe(true);
  });

  it('defaults coral bypass to false when omitted', () => {
    expectCoralBypassValue({}, false);
  });

  it('preserves explicit coral bypass true', () => {
    expectCoralBypassValue({ bypass: true }, true);
  });
});
