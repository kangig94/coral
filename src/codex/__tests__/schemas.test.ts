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

  it('accepts wait with job_ids array', () => {
    const result = codexOpSchema.parse({
      op: 'wait',
      job_ids: ['12345678-1234-1234-1234-123456789abc'],
    });
    expect(result).toMatchObject({
      op: 'wait',
      job_ids: ['12345678-1234-1234-1234-123456789abc'],
    });
  });

  it('wait rejects empty job_ids array', () => {
    expect(() => codexOpSchema.parse({ op: 'wait', job_ids: [] })).toThrow(ZodError);
  });

  it('wait rejects non-UUID job_ids', () => {
    expect(() => codexOpSchema.parse({ op: 'wait', job_ids: ['not-a-uuid'] })).toThrow(ZodError);
  });

  it('wait accepts optional timeout_seconds', () => {
    const a = codexOpSchema.parse({
      op: 'wait',
      job_ids: ['12345678-1234-1234-1234-123456789abc'],
      timeout_seconds: 1,
    });
    const b = codexOpSchema.parse({
      op: 'wait',
      job_ids: ['12345678-1234-1234-1234-123456789abc'],
      timeout_seconds: 600,
    });

    expect(a).toMatchObject({ op: 'wait', timeout_seconds: 1 });
    expect(b).toMatchObject({ op: 'wait', timeout_seconds: 600 });
  });

  it('wait rejects timeout_seconds out of range', () => {
    expect(() => codexOpSchema.parse({
      op: 'wait',
      job_ids: ['12345678-1234-1234-1234-123456789abc'],
      timeout_seconds: 0,
    })).toThrow(ZodError);

    expect(() => codexOpSchema.parse({
      op: 'wait',
      job_ids: ['12345678-1234-1234-1234-123456789abc'],
      timeout_seconds: 601,
    })).toThrow(ZodError);
  });

  it('wait accepts optional cursors object', () => {
    const result = codexOpSchema.parse({
      op: 'wait',
      job_ids: ['12345678-1234-1234-1234-123456789abc'],
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
    const result = codexOpSchema.parse({ op: 'abort', session: 'session-a' });
    expect(result).toMatchObject({ op: 'abort', session: 'session-a' });
  });

  it('accepts abort with job_id only', () => {
    const result = codexOpSchema.parse({ op: 'abort', job_id: '12345678-1234-1234-1234-123456789abc' });
    expect(result).toMatchObject({ op: 'abort', job_id: '12345678-1234-1234-1234-123456789abc' });
  });

  it('accepts abort with neither session nor job_id (handler enforces one-of)', () => {
    const result = codexOpSchema.parse({ op: 'abort' });
    expect(result).toMatchObject({ op: 'abort' });
  });
});
