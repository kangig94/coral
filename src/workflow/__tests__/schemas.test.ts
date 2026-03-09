import { describe, expect, it } from 'vitest';
import { workflowInputSchema } from '../schemas.js';

describe('workflowInputSchema', () => {
  it('accepts minimal valid input and defaults provider to claude', () => {
    const parsed = workflowInputSchema.parse({
      expression: 'architect -> resolver',
      init_prompt: 'hello',
    });

    expect(parsed.provider).toBe('claude');
    expect(parsed.stale_timeout_seconds).toBe(900);
  });

  it('accepts optional context string', () => {
    const parsed = workflowInputSchema.parse({
      expression: 'architect -> resolver',
      init_prompt: 'hello',
      context: 'Shared briefing',
    });

    expect(parsed.context).toBe('Shared briefing');
  });

  it('accepts full valid input with atoms', () => {
    const parsed = workflowInputSchema.parse({
      expression: '(architect, critic) -> resolver@claude',
      init_prompt: 'analyze',
      provider: 'claude',
      atoms: {
        architect: {
          instruction: 'Review the auth flow with extra attention to edge cases.',
        },
      },
    });

    expect(parsed.provider).toBe('claude');
    expect(parsed.atoms?.architect?.instruction).toContain('auth flow');
  });

  it('rejects missing expression', () => {
    expect(() => workflowInputSchema.parse({ init_prompt: 'hello' })).toThrow();
  });

  it('rejects missing init_prompt', () => {
    expect(() => workflowInputSchema.parse({ expression: 'architect' })).toThrow();
  });

  it('rejects empty expression', () => {
    expect(() => workflowInputSchema.parse({ expression: '', init_prompt: 'hello' })).toThrow('Expression required');
  });

  it('rejects empty init_prompt', () => {
    expect(() => workflowInputSchema.parse({ expression: 'architect', init_prompt: '' })).toThrow('Prompt required');
  });

  it('accepts provider identifiers beyond built-in providers', () => {
    const parsed = workflowInputSchema.parse({
      expression: 'architect',
      init_prompt: 'hello',
      provider: 'openai',
    });
    expect(parsed.provider).toBe('openai');
  });

  it('rejects invalid provider identifier syntax', () => {
    expect(() => workflowInputSchema.parse({
      expression: 'architect',
      init_prompt: 'hello',
      provider: 'OpenAI',
    })).toThrow();
  });

  it('rejects non-object atoms per atom', () => {
    expect(() => workflowInputSchema.parse({
      expression: 'architect',
      init_prompt: 'hello',
      atoms: {
        architect: 'bad-shape',
      },
    })).toThrow();
  });

  it('rejects legacy top-level args key', () => {
    expect(() => workflowInputSchema.parse({
      expression: 'architect',
      init_prompt: 'hello',
      args: {},
    })).toThrow(/Unrecognized key\(s\) in object: 'args'/);
  });

  it('rejects legacy top-level prompt key', () => {
    const parsed = workflowInputSchema.safeParse({
      expression: 'architect',
      init_prompt: 'hello',
      prompt: 'legacy hello',
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected parse failure');
    expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "Unrecognized key(s) in object: 'prompt'",
      }),
    ]));
  });

  it('accepts atoms instruction field', () => {
    const parsed = workflowInputSchema.parse({
      expression: 'architect',
      init_prompt: 'hello',
      atoms: {
        architect: {
          instruction: 'Do a security pass.',
        },
      },
    });

    expect(parsed.atoms?.architect?.instruction).toBe('Do a security pass.');
  });

  it('rejects effort field in atom config (removed from MCP surface)', () => {
    expect(() => workflowInputSchema.parse({
      expression: 'architect',
      init_prompt: 'hello',
      atoms: {
        architect: {
          effort: 'xhigh',
        },
      },
    })).toThrow();
  });

  it('rejects unknown keys in atom config', () => {
    expect(() => workflowInputSchema.parse({
      expression: 'architect',
      init_prompt: 'hello',
      atoms: {
        architect: {
          model: 'o4-mini',
        },
      },
    })).toThrow(/Unrecognized key\(s\) in object: 'model'/);
  });

  it.each([
    { key: 'working_directory', value: '/tmp/work' },
    { key: 'files', value: ['README.md'] },
    { key: 'flags', value: ['--deep'] },
  ])('rejects legacy atom key $key', ({ key, value }) => {
    expect(() => workflowInputSchema.parse({
      expression: 'architect',
      init_prompt: 'hello',
      atoms: {
        architect: {
          [key]: value,
        },
      },
    })).toThrow(/Unrecognized key\(s\) in object/);
  });

  it('rejects bypass in atoms via strict object validation', () => {
    expect(() => workflowInputSchema.parse({
      expression: 'architect',
      init_prompt: 'hello',
      atoms: {
        architect: {
          bypass: true,
        },
      },
    })).toThrow(/Unrecognized key\(s\) in object: 'bypass'/);
  });

  it('rejects provider: null', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', init_prompt: 'hi', provider: null }),
    ).toThrow();
  });

  it('accepts atoms: {} empty object', () => {
    const parsed = workflowInputSchema.parse({ expression: 'a', init_prompt: 'hi', atoms: {} });
    expect(parsed.atoms).toEqual({});
  });

  it('accepts stale_timeout_seconds set to zero (disable stale recovery)', () => {
    const parsed = workflowInputSchema.parse({
      expression: 'architect',
      init_prompt: 'hello',
      stale_timeout_seconds: 0,
    });
    expect(parsed.stale_timeout_seconds).toBe(0);
  });

  it('rejects atoms with array value for atom (not a record)', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', init_prompt: 'hi', atoms: { a: [1, 2, 3] } }),
    ).toThrow();
  });
});

describe('provider identifier boundary values', () => {
  it('single lowercase letter is a valid provider identifier', () => {
    const parsed = workflowInputSchema.parse({ expression: 'a', init_prompt: 'hi', provider: 'a' });
    expect(parsed.provider).toBe('a');
  });

  it('provider starting with digit is rejected', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', init_prompt: 'hi', provider: '1abc' }),
    ).toThrow();
  });

  it('provider starting with hyphen is rejected', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', init_prompt: 'hi', provider: '-abc' }),
    ).toThrow();
  });

  it('provider with internal hyphens (a-b-c) is accepted', () => {
    const parsed = workflowInputSchema.parse({ expression: 'a', init_prompt: 'hi', provider: 'a-b-c' });
    expect(parsed.provider).toBe('a-b-c');
  });

  it('empty string provider is rejected', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', init_prompt: 'hi', provider: '' }),
    ).toThrow();
  });

  it('provider with uppercase letter is rejected', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', init_prompt: 'hi', provider: 'Claude' }),
    ).toThrow();
  });

  it('provider with underscore is rejected (providerIdentPattern excludes underscores)', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'a', init_prompt: 'hi', provider: 'my_provider' }),
    ).toThrow();
  });
});

describe('stale_timeout_seconds validation', () => {
  it('rejects negative stale_timeout_seconds', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'architect', init_prompt: 'hello', stale_timeout_seconds: -1 }),
    ).toThrow();
  });

  it('rejects stale_timeout_seconds supplied as a string', () => {
    expect(() =>
      workflowInputSchema.parse({ expression: 'architect', init_prompt: 'hello', stale_timeout_seconds: '900' }),
    ).toThrow();
  });

  it('accepts stale_timeout_seconds of exactly 1 (minimum positive value)', () => {
    const parsed = workflowInputSchema.parse({ expression: 'architect', init_prompt: 'hello', stale_timeout_seconds: 1 });
    expect(parsed.stale_timeout_seconds).toBe(1);
  });
});
