import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { codexOpSchema, coralAgentSchema } from '../schemas.js';

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
    const result = codexOpSchema.parse({ op: 'abort', session: '12345678-1234-1234-1234-123456789abc' });
    expect(result).toMatchObject({ op: 'abort', session: '12345678-1234-1234-1234-123456789abc' });
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

  it('accepts wait with sessions array', () => {
    const result = codexOpSchema.parse({
      op: 'wait',
      sessions: ['12345678-1234-1234-1234-123456789abc'],
    });
    expect(result).toMatchObject({
      op: 'wait',
      sessions: ['12345678-1234-1234-1234-123456789abc'],
    });
  });

  it('wait rejects empty sessions array', () => {
    expect(() => codexOpSchema.parse({ op: 'wait', sessions: [] })).toThrow(ZodError);
  });

  it('wait rejects non-UUID sessions', () => {
    expect(() => codexOpSchema.parse({ op: 'wait', sessions: ['not-a-uuid'] })).toThrow(ZodError);
  });

  it('wait rejects mixed UUID/non-UUID sessions', () => {
    expect(() => codexOpSchema.parse({
      op: 'wait',
      sessions: ['12345678-1234-1234-1234-123456789abc', 'not-a-uuid'],
    })).toThrow(ZodError);
  });

  it('wait accepts optional timeout_seconds', () => {
    const a = codexOpSchema.parse({
      op: 'wait',
      sessions: ['12345678-1234-1234-1234-123456789abc'],
      timeout_seconds: 1,
    });
    const b = codexOpSchema.parse({
      op: 'wait',
      sessions: ['12345678-1234-1234-1234-123456789abc'],
      timeout_seconds: 600,
    });

    expect(a).toMatchObject({ op: 'wait', timeout_seconds: 1 });
    expect(b).toMatchObject({ op: 'wait', timeout_seconds: 600 });
  });

  it('wait rejects timeout_seconds out of range', () => {
    expect(() => codexOpSchema.parse({
      op: 'wait',
      sessions: ['12345678-1234-1234-1234-123456789abc'],
      timeout_seconds: 0,
    })).toThrow(ZodError);

    expect(() => codexOpSchema.parse({
      op: 'wait',
      sessions: ['12345678-1234-1234-1234-123456789abc'],
      timeout_seconds: 1201,
    })).toThrow(ZodError);
  });

  it('wait accepts optional cursors object', () => {
    const result = codexOpSchema.parse({
      op: 'wait',
      sessions: ['12345678-1234-1234-1234-123456789abc'],
      cursors: {
        '12345678-1234-1234-1234-123456789abc': 0,
      },
    });

    expect(result).toMatchObject({
      op: 'wait',
      cursors: {
        '12345678-1234-1234-1234-123456789abc': 0,
      },
    });
  });

  it('accepts abort with session only', () => {
    const result = codexOpSchema.parse({ op: 'abort', session: '12345678-1234-1234-1234-123456789abc' });
    expect(result).toMatchObject({ op: 'abort', session: '12345678-1234-1234-1234-123456789abc' });
  });

  it('abort rejects non-UUID session', () => {
    expect(() => codexOpSchema.parse({ op: 'abort', session: 'session-a' })).toThrow(ZodError);
  });

  it('abort requires session', () => {
    expect(() => codexOpSchema.parse({ op: 'abort' })).toThrow(ZodError);
  });

  it('exec accepts non-UUID session reference', () => {
    const result = codexOpSchema.parse({ op: 'exec', session: 'session-a', prompt: 'Continue' });
    expect(result).toMatchObject({ op: 'exec', session: 'session-a', prompt: 'Continue' });
  });

  it('fork accepts non-UUID session reference', () => {
    const result = codexOpSchema.parse({ op: 'fork', session: 'session-a', prompt: 'Fork this' });
    expect(result).toMatchObject({ op: 'fork', session: 'session-a', prompt: 'Fork this' });
  });
});

describe('coralAgentSchema', () => {
  it('accepts coral:scanner with prompt', () => {
    const result = coralAgentSchema.parse({ op: 'coral:scanner', prompt: 'analyze this' });
    expect(result).toMatchObject({ op: 'coral:scanner', prompt: 'analyze this' });
  });

  it('accepts coral:architect with session (resume)', () => {
    const result = coralAgentSchema.parse({ op: 'coral:architect', session: 'session-a', prompt: 'continue' });
    expect(result).toMatchObject({ op: 'coral:architect', session: 'session-a', prompt: 'continue' });
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
});
