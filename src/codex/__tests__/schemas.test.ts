import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { codexOpSchema } from '../schemas.js';

describe('codexOpSchema', () => {
  it('accepts exec without session', () => {
    const result = codexOpSchema.parse({ op: 'exec', prompt: 'Hello', name: 'session-a' });
    expect(result).toMatchObject({ op: 'exec', prompt: 'Hello', name: 'session-a' });
  });

  it('accepts exec with session', () => {
    const result = codexOpSchema.parse({ op: 'exec', session: 'session-a', prompt: 'Continue' });
    expect(result).toMatchObject({ op: 'exec', session: 'session-a', prompt: 'Continue' });
  });

  it('accepts list', () => {
    const result = codexOpSchema.parse({ op: 'list' });
    expect(result).toEqual({ op: 'list' });
  });

  it('accepts fork', () => {
    const result = codexOpSchema.parse({ op: 'fork', session: 'session-a', prompt: 'Fork this' });
    expect(result).toMatchObject({ op: 'fork', session: 'session-a', prompt: 'Fork this' });
  });

  it('accepts abort', () => {
    const result = codexOpSchema.parse({ op: 'abort', session: 'session-a' });
    expect(result).toMatchObject({ op: 'abort', session: 'session-a' });
  });

  it('list rejects unknown properties', () => {
    expect(() => codexOpSchema.parse({ op: 'list', extra: true })).toThrow(ZodError);
  });

  it('rejects unknown discriminator op', () => {
    expect(() => codexOpSchema.parse({ op: 'invalid_op' })).toThrow(ZodError);
  });

  it('rejects missing op', () => {
    expect(() => codexOpSchema.parse({})).toThrow(ZodError);
  });
});
