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

  it('rejects abort discriminator (removed — use unified abort tool)', () => {
    expectCodexParseError({ op: 'abort', session: '12345678-1234-4234-8234-123456789abc' });
  });

  it('rejects legacy wait payloads because wait op is unsupported', () => {
    const result = codexOpSchema.safeParse({ op: 'wait', job_ids: ['12345678-1234-1234-1234-123456789abc'] });
    expect(result.success).toBe(false);
  });

  it('parses exec with minimal fields', () => {
    const parsed = codexOpSchema.parse({ op: 'exec', prompt: 'hello' });
    expect(parsed).toMatchObject({ op: 'exec', prompt: 'hello' });
  });

  it('parses fork with session', () => {
    const parsed = codexOpSchema.parse({ op: 'fork', session: 'base-session' });
    expect(parsed).toMatchObject({ op: 'fork', session: 'base-session' });
  });
});

describe('coralAgentSchema', () => {
  it('accepts all optional fields alongside required op and prompt', () => {
    const result = coralAgentSchema.parse({
      op: 'coral:scanner',
      prompt: 'analyze',
      working_directory: '/tmp',
    });
    expect(result).toMatchObject({
      op: 'coral:scanner',
      prompt: 'analyze',
      working_directory: '/tmp',
    });
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
