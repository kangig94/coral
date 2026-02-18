import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  codexExecuteSchema,
  codexSessionCreateSchema,
  codexSessionSendSchema,
  codexSessionListSchema,
  codexSessionForkSchema,
} from '../schemas.js';

describe('codexExecuteSchema', () => {
  it('accepts valid input', () => {
    const result = codexExecuteSchema.parse({ prompt: 'Hello', model: 'o4-mini' });
    expect(result.prompt).toBe('Hello');
    expect(result.model).toBe('o4-mini');
  });

  it('accepts input without optional fields', () => {
    const result = codexExecuteSchema.parse({ prompt: 'Hello' });
    expect(result.prompt).toBe('Hello');
    expect(result.model).toBeUndefined();
  });

  it('rejects missing prompt', () => {
    expect(() => codexExecuteSchema.parse({})).toThrow(ZodError);
  });

  it('rejects empty prompt', () => {
    expect(() => codexExecuteSchema.parse({ prompt: '' })).toThrow(ZodError);
  });

  it('rejects model with leading dash (flag injection)', () => {
    expect(() => codexExecuteSchema.parse({ prompt: 'Hi', model: '--dangerous' })).toThrow(ZodError);
  });

  it('rejects model with shell characters', () => {
    expect(() => codexExecuteSchema.parse({ prompt: 'Hi', model: 'model; rm -rf /' })).toThrow(ZodError);
  });

  it('accepts model with dots and hyphens', () => {
    const result = codexExecuteSchema.parse({ prompt: 'Hi', model: 'gpt-4.1-mini' });
    expect(result.model).toBe('gpt-4.1-mini');
  });

  it('rejects numeric prompt', () => {
    expect(() => codexExecuteSchema.parse({ prompt: 123 })).toThrow(ZodError);
  });
});

describe('codexSessionCreateSchema', () => {
  it('accepts valid input', () => {
    const result = codexSessionCreateSchema.parse({ name: 'test', prompt: 'Hello' });
    expect(result.name).toBe('test');
  });

  it('rejects missing name', () => {
    expect(() => codexSessionCreateSchema.parse({ prompt: 'Hello' })).toThrow(ZodError);
  });

  it('rejects empty name', () => {
    expect(() => codexSessionCreateSchema.parse({ name: '', prompt: 'Hello' })).toThrow(ZodError);
  });
});

describe('codexSessionSendSchema', () => {
  it('accepts valid input', () => {
    const result = codexSessionSendSchema.parse({ session: 'my-session', prompt: 'Next' });
    expect(result.session).toBe('my-session');
  });

  it('rejects missing session', () => {
    expect(() => codexSessionSendSchema.parse({ prompt: 'Hello' })).toThrow(ZodError);
  });

  it('accepts working_directory', () => {
    const result = codexSessionSendSchema.parse({
      session: 'my-session',
      prompt: 'Review this',
      working_directory: '/home/user/project',
    });
    expect(result.working_directory).toBe('/home/user/project');
  });

  it('accepts without working_directory (backwards compatible)', () => {
    const result = codexSessionSendSchema.parse({
      session: 'my-session',
      prompt: 'Review this',
    });
    expect(result.working_directory).toBeUndefined();
  });
});

describe('codexSessionListSchema', () => {
  it('accepts empty object', () => {
    const result = codexSessionListSchema.parse({});
    expect(result).toEqual({});
  });

  it('passes through unknown properties', () => {
    const result = codexSessionListSchema.parse({ extra: true });
    expect(result).toHaveProperty('extra', true);
  });
});

describe('codexSessionForkSchema', () => {
  it('accepts valid input', () => {
    const result = codexSessionForkSchema.parse({ session: 'abc', prompt: 'Fork this' });
    expect(result.session).toBe('abc');
  });

  it('accepts without optional prompt', () => {
    const result = codexSessionForkSchema.parse({ session: 'abc' });
    expect(result.prompt).toBeUndefined();
  });

  it('rejects missing session', () => {
    expect(() => codexSessionForkSchema.parse({})).toThrow(ZodError);
  });

  it('rejects dangerous model in fork', () => {
    expect(() => codexSessionForkSchema.parse({ session: 'abc', model: '$HOME' })).toThrow(ZodError);
  });

  it('accepts working_directory', () => {
    const result = codexSessionForkSchema.parse({
      session: 'abc',
      working_directory: '/home/user/project',
    });
    expect(result.working_directory).toBe('/home/user/project');
  });
});
