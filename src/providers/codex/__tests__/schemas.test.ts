import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { codexOpSchema, coralAgentSchema } from '../schemas.js';

function expectCodexParseError(input: unknown): void {
  expect(() => codexOpSchema.parse(input)).toThrow(ZodError);
}

function expectCoralParseError(op: string): void {
  expect(() => coralAgentSchema.parse({ op, prompt: 'x' })).toThrow(ZodError);
}

describe('codexOpSchema', () => {
  it('list rejects unknown properties', () => {
    expectCodexParseError({ op: 'list', extra: true });
  });

  it('rejects unknown discriminator op', () => {
    expectCodexParseError({ op: 'invalid_op' });
  });

  it('rejects missing op', () => {
    expectCodexParseError({});
  });

  it('rejects wait discriminator', () => {
    expectCodexParseError({
      op: 'wait',
      sessions: ['12345678-1234-1234-1234-123456789abc'],
      timeout_seconds: 10,
    });
  });

  it('abort rejects non-UUID session', () => {
    expectCodexParseError({ op: 'abort', session: 'session-a' });
  });

  it('abort requires session', () => {
    expectCodexParseError({ op: 'abort' });
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
    if (parsed.op !== 'exec') throw new Error('Expected exec op');
    expect(parsed.bypass).toBe(false);
  });

  it('preserves explicit exec bypass true', () => {
    const parsed = codexOpSchema.parse({ op: 'exec', prompt: 'hello', bypass: true });
    if (parsed.op !== 'exec') throw new Error('Expected exec op');
    expect(parsed.bypass).toBe(true);
  });

  it('defaults fork bypass to false when omitted', () => {
    const parsed = codexOpSchema.parse({
      op: 'fork',
      session: 'base-session',
    });
    if (parsed.op !== 'fork') throw new Error('Expected fork op');
    expect(parsed.bypass).toBe(false);
  });

  it('preserves explicit fork bypass true', () => {
    const parsed = codexOpSchema.parse({
      op: 'fork',
      session: 'base-session',
      bypass: true,
    });
    if (parsed.op !== 'fork') throw new Error('Expected fork op');
    expect(parsed.bypass).toBe(true);
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
    expectCoralParseError('coral:');
  });

  it('rejects non-coral prefix', () => {
    expectCoralParseError('exec-scanner');
  });

  it('rejects coral:../x path traversal', () => {
    expectCoralParseError('coral:../x');
  });

  it('rejects coral:scanner/extra slash in name', () => {
    expectCoralParseError('coral:scanner/extra');
  });

  it('rejects uppercase letter coral:Scanner', () => {
    expectCoralParseError('coral:Scanner');
  });

  it('rejects underscore coral:scanner_two', () => {
    expectCoralParseError('coral:scanner_two');
  });

  it('rejects hyphen-start coral:-scanner', () => {
    expectCoralParseError('coral:-scanner');
  });

  it('rejects double-colon coral::scanner', () => {
    expectCoralParseError('coral::scanner');
  });
});
