import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { codexOpSchema, coralAgentSchema } from '../schemas.js';

describe('codexOpSchema', () => {
  it('list rejects unknown properties', () => {
    expect(() => codexOpSchema.parse({ op: 'list', extra: true })).toThrow(ZodError);
  });

  it('rejects unknown discriminator op', () => {
    expect(() => codexOpSchema.parse({ op: 'invalid_op' })).toThrow(ZodError);
  });

  it('rejects missing op', () => {
    expect(() => codexOpSchema.parse({})).toThrow(ZodError);
  });

  it('rejects wait discriminator', () => {
    expect(() => codexOpSchema.parse({
      op: 'wait',
      sessions: ['12345678-1234-1234-1234-123456789abc'],
      timeout_seconds: 10,
    })).toThrow(ZodError);
  });

  it('abort rejects non-UUID session', () => {
    expect(() => codexOpSchema.parse({ op: 'abort', session: 'session-a' })).toThrow(ZodError);
  });

  it('abort requires session', () => {
    expect(() => codexOpSchema.parse({ op: 'abort' })).toThrow(ZodError);
  });

  it('rejects legacy wait payloads because wait op is unsupported', () => {
    const result = codexOpSchema.safeParse({ op: 'wait', job_ids: ['12345678-1234-1234-1234-123456789abc'] });
    expect(result.success).toBe(false);
  });

  it('abort rejects job_id (old field name)', () => {
    const result = codexOpSchema.safeParse({ op: 'abort', job_id: '12345678-1234-1234-1234-123456789abc' });
    expect(result.success).toBe(false);
  });

  it('defaults exec bypass to false when omitted', () => {
    const parsed = codexOpSchema.parse({ op: 'exec', prompt: 'hello' });
    expect(parsed.op).toBe('exec');
    if (parsed.op === 'exec') expect(parsed.bypass).toBe(false);
  });

  it('preserves explicit exec bypass true', () => {
    const parsed = codexOpSchema.parse({ op: 'exec', prompt: 'hello', bypass: true });
    expect(parsed.op).toBe('exec');
    if (parsed.op === 'exec') expect(parsed.bypass).toBe(true);
  });

  it('defaults fork bypass to false when omitted', () => {
    const parsed = codexOpSchema.parse({
      op: 'fork',
      session: 'base-session',
    });
    expect(parsed.op).toBe('fork');
    if (parsed.op === 'fork') expect(parsed.bypass).toBe(false);
  });

  it('preserves explicit fork bypass true', () => {
    const parsed = codexOpSchema.parse({
      op: 'fork',
      session: 'base-session',
      bypass: true,
    });
    expect(parsed.op).toBe('fork');
    if (parsed.op === 'fork') expect(parsed.bypass).toBe(true);
  });
});

describe('coralAgentSchema', () => {
  it('accepts all optional fields alongside required op and prompt', () => {
    const result = coralAgentSchema.parse({
      op: 'coral:scanner',
      prompt: 'analyze',
      model: 'o4-mini',
      working_directory: '/tmp',
      effort: 'high',
      bypass: true,
    });
    expect(result).toMatchObject({
      op: 'coral:scanner',
      prompt: 'analyze',
      model: 'o4-mini',
    });
  });

  it('defaults coral bypass to false when omitted', () => {
    const parsed = coralAgentSchema.parse({
      op: 'coral:architect',
      prompt: 'Do it',
    });
    expect(parsed.bypass).toBe(false);
  });

  it('preserves explicit coral bypass true', () => {
    const parsed = coralAgentSchema.parse({
      op: 'coral:architect',
      prompt: 'Do it',
      bypass: true,
    });
    expect(parsed.bypass).toBe(true);
  });

  it('accepts single-char agent name coral:a', () => {
    expect(() => coralAgentSchema.parse({ op: 'coral:a', prompt: 'go' })).not.toThrow();
  });

  it('rejects coral: with empty agent name', () => {
    expect(() => coralAgentSchema.parse({ op: 'coral:', prompt: 'x' })).toThrow(ZodError);
  });

  it('rejects non-coral prefix', () => {
    expect(() => coralAgentSchema.parse({ op: 'exec-scanner', prompt: 'x' })).toThrow(ZodError);
  });

  it('rejects coral:../x path traversal', () => {
    expect(() => coralAgentSchema.parse({ op: 'coral:../x', prompt: 'x' })).toThrow(ZodError);
  });

  it('rejects coral:scanner/extra slash in name', () => {
    expect(() => coralAgentSchema.parse({ op: 'coral:scanner/extra', prompt: 'x' })).toThrow(ZodError);
  });

  it('rejects uppercase letter coral:Scanner', () => {
    expect(() => coralAgentSchema.parse({ op: 'coral:Scanner', prompt: 'go' })).toThrow(ZodError);
  });

  it('rejects underscore coral:scanner_two', () => {
    expect(() => coralAgentSchema.parse({ op: 'coral:scanner_two', prompt: 'go' })).toThrow(ZodError);
  });

  it('rejects hyphen-start coral:-scanner', () => {
    expect(() => coralAgentSchema.parse({ op: 'coral:-scanner', prompt: 'go' })).toThrow(ZodError);
  });

  it('rejects double-colon coral::scanner', () => {
    expect(() => coralAgentSchema.parse({ op: 'coral::scanner', prompt: 'go' })).toThrow(ZodError);
  });
});
