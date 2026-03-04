import { describe, expect, it } from 'vitest';
import { workflowInputSchema } from '../schemas.js';

describe('workflowInputSchema', () => {
  it('accepts minimal valid input and defaults provider to codex', () => {
    const parsed = workflowInputSchema.parse({
      expression: 'architect -> resolver',
      prompt: 'hello',
    });

    expect(parsed.provider).toBe('codex');
    expect(parsed.stale_timeout_seconds).toBe(900);
  });

  it('accepts full valid input', () => {
    const parsed = workflowInputSchema.parse({
      expression: '(architect, critic) -> resolver@claude',
      prompt: 'analyze',
      provider: 'claude',
      args: {
        architect: {
          model: 'o4-mini',
          working_directory: '/tmp/work',
          files: ['README.md'],
          flags: ['--fast'],
          priority: 'high',
        },
      },
    });

    expect(parsed.provider).toBe('claude');
    expect(parsed.args?.architect?.priority).toBe('high');
  });

  it('rejects missing expression', () => {
    expect(() => workflowInputSchema.parse({ prompt: 'hello' })).toThrow();
  });

  it('rejects missing prompt', () => {
    expect(() => workflowInputSchema.parse({ expression: 'architect' })).toThrow();
  });

  it('rejects empty expression', () => {
    expect(() => workflowInputSchema.parse({ expression: '', prompt: 'hello' })).toThrow('Expression required');
  });

  it('rejects empty prompt', () => {
    expect(() => workflowInputSchema.parse({ expression: 'architect', prompt: '' })).toThrow('Prompt required');
  });

  it('accepts provider identifiers beyond built-in providers', () => {
    const parsed = workflowInputSchema.parse({
      expression: 'architect',
      prompt: 'hello',
      provider: 'openai',
    });
    expect(parsed.provider).toBe('openai');
  });

  it('rejects invalid provider identifier syntax', () => {
    expect(() => workflowInputSchema.parse({
      expression: 'architect',
      prompt: 'hello',
      provider: 'OpenAI',
    })).toThrow();
  });

  it('rejects non-object args per atom', () => {
    expect(() => workflowInputSchema.parse({
      expression: 'architect',
      prompt: 'hello',
      args: {
        architect: 'bad-shape',
      },
    })).toThrow();
  });

  it('rejects args.<atom>.bypass in v1', () => {
    expect(() => workflowInputSchema.parse({
      expression: 'architect',
      prompt: 'hello',
      args: {
        architect: {
          bypass: true,
        },
      },
    })).toThrow('Workflow v1 does not support args.<atom>.bypass');
  });

  it('accepts arbitrary context keys in args', () => {
    const parsed = workflowInputSchema.parse({
      expression: 'architect',
      prompt: 'hello',
      args: {
        architect: {
          ticket: 1234,
          labels: ['p1', 'infra'],
          nested: { safe: true },
        },
      },
    });

    expect(parsed.args?.architect?.ticket).toBe(1234);
  });

  it('rejects provider: null', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', prompt: 'hi', provider: null }),
    ).toThrow();
  });

  it('accepts args: {} empty object', () => {
    const parsed = workflowInputSchema.parse({ expression: 'a', prompt: 'hi', args: {} });
    expect(parsed.args).toEqual({});
  });

  it('accepts stale_timeout_seconds set to zero (disable stale recovery)', () => {
    const parsed = workflowInputSchema.parse({
      expression: 'architect',
      prompt: 'hello',
      stale_timeout_seconds: 0,
    });
    expect(parsed.stale_timeout_seconds).toBe(0);
  });

  it('rejects bypass: null (property presence, not truthiness)', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', prompt: 'hi', args: { a: { bypass: null } } }),
    ).toThrow('Workflow v1 does not support args.<atom>.bypass');
  });

  it('rejects bypass: 0 (falsy but present)', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', prompt: 'hi', args: { a: { bypass: 0 } } }),
    ).toThrow('Workflow v1 does not support args.<atom>.bypass');
  });

  it('rejects bypass on one atom only — error is per-atom, clean atom passes', () => {
    expect(() =>
      workflowInputSchema.parse({
        expression: '(a, b)',
        prompt: 'hi',
        args: { a: { bypass: true }, b: { model: 'o4-mini' } },
      }),
    ).toThrow('Workflow v1 does not support args.<atom>.bypass');

    const parsed = workflowInputSchema.parse({
      expression: '(a, b)',
      prompt: 'hi',
      args: { b: { model: 'o4-mini' } },
    });
    expect(parsed.args?.b?.model).toBe('o4-mini');
  });

  it('rejects args with array value for atom (not a record)', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', prompt: 'hi', args: { a: [1, 2, 3] } }),
    ).toThrow();
  });
});

describe('provider identifier boundary values', () => {
  it('single lowercase letter is a valid provider identifier', () => {
    const parsed = workflowInputSchema.parse({ expression: 'a', prompt: 'hi', provider: 'a' });
    expect(parsed.provider).toBe('a');
  });

  it('provider starting with digit is rejected', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', prompt: 'hi', provider: '1abc' }),
    ).toThrow();
  });

  it('provider starting with hyphen is rejected', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', prompt: 'hi', provider: '-abc' }),
    ).toThrow();
  });

  it('provider with internal hyphens (a-b-c) is accepted', () => {
    const parsed = workflowInputSchema.parse({ expression: 'a', prompt: 'hi', provider: 'a-b-c' });
    expect(parsed.provider).toBe('a-b-c');
  });

  it('empty string provider is rejected', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', prompt: 'hi', provider: '' }),
    ).toThrow();
  });

  it('provider with uppercase letter is rejected', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', prompt: 'hi', provider: 'Claude' }),
    ).toThrow();
  });

  it('provider with underscore is rejected (providerIdentPattern excludes underscores)', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', prompt: 'hi', provider: 'my_provider' }),
    ).toThrow();
  });
});

describe('stale_timeout_seconds validation', () => {
  it('rejects negative stale_timeout_seconds', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'architect', prompt: 'hello', stale_timeout_seconds: -1 }),
    ).toThrow();
  });

  it('rejects stale_timeout_seconds supplied as a string', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'architect', prompt: 'hello', stale_timeout_seconds: '900' }),
    ).toThrow();
  });

  it('accepts stale_timeout_seconds of exactly 1 (minimum positive value)', () => {
    const parsed = workflowInputSchema.parse({ expression: 'architect', prompt: 'hello', stale_timeout_seconds: 1 });
    expect(parsed.stale_timeout_seconds).toBe(1);
  });
});
