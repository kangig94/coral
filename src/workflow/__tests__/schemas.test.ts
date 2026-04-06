import { describe, expect, it } from 'vitest';
import { workflowInputSchema } from '../schemas.js';

describe('workflowInputSchema', () => {
  it('accepts minimal valid input and defaults provider to claude', () => {
    const parsed = workflowInputSchema.parse({
      expression: 'architect -> resolver',
      start_prompt: 'hello',
    });

    expect(parsed.provider).toBe('claude');
  });

  it('accepts optional context string', () => {
    const parsed = workflowInputSchema.parse({
      expression: 'architect -> resolver',
      start_prompt: 'hello',
      context: 'Shared briefing',
    });

    expect(parsed.context).toBe('Shared briefing');
  });

  it('rejects missing expression', () => {
    expect(() => workflowInputSchema.parse({ start_prompt: 'hello' })).toThrow();
  });

  it('rejects missing start_prompt', () => {
    expect(() => workflowInputSchema.parse({ expression: 'architect' })).toThrow();
  });

  it('rejects empty expression', () => {
    expect(() => workflowInputSchema.parse({ expression: '', start_prompt: 'hello' })).toThrow('Expression required');
  });

  it('rejects empty start_prompt', () => {
    expect(() => workflowInputSchema.parse({ expression: 'architect', start_prompt: '' })).toThrow('Prompt required');
  });

  it('accepts provider identifiers beyond built-in providers', () => {
    const parsed = workflowInputSchema.parse({
      expression: 'architect',
      start_prompt: 'hello',
      provider: 'openai',
    });
    expect(parsed.provider).toBe('openai');
  });

  it('rejects invalid provider identifier syntax', () => {
    expect(() =>
      workflowInputSchema.parse({
        expression: 'architect',
        start_prompt: 'hello',
        provider: 'OpenAI',
      }),
    ).toThrow();
  });

  it('rejects legacy top-level args key', () => {
    expect(() =>
      workflowInputSchema.parse({
        expression: 'architect',
        start_prompt: 'hello',
        args: {},
      }),
    ).toThrow(/Unrecognized key\(s\) in object: 'args'/);
  });

  it('rejects legacy top-level prompt key', () => {
    const parsed = workflowInputSchema.safeParse({
      expression: 'architect',
      start_prompt: 'hello',
      prompt: 'legacy hello',
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('expected parse failure');
    expect(parsed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Unrecognized key(s) in object: 'prompt'",
        }),
      ]),
    );
  });

  it('rejects removed atoms field', () => {
    expect(() =>
      workflowInputSchema.parse({
        expression: 'architect',
        start_prompt: 'hello',
        atoms: { architect: { instruction: 'focus' } },
      }),
    ).toThrow(/Unrecognized key\(s\) in object: 'atoms'/);
  });

  it('rejects removed stale_timeout_seconds field', () => {
    expect(() =>
      workflowInputSchema.parse({
        expression: 'architect',
        start_prompt: 'hello',
        stale_timeout_seconds: 900,
      }),
    ).toThrow(/Unrecognized key\(s\) in object: 'stale_timeout_seconds'/);
  });

  it('rejects provider: null', () => {
    expect(() => workflowInputSchema.parse({ expression: 'a', start_prompt: 'hi', provider: null })).toThrow();
  });
});

describe('provider identifier boundary values', () => {
  it('single lowercase letter is a valid provider identifier', () => {
    const parsed = workflowInputSchema.parse({ expression: 'a', start_prompt: 'hi', provider: 'a' });
    expect(parsed.provider).toBe('a');
  });

  it('provider starting with digit is rejected', () => {
    expect(() => workflowInputSchema.parse({ expression: 'a', start_prompt: 'hi', provider: '1abc' })).toThrow();
  });

  it('provider starting with hyphen is rejected', () => {
    expect(() => workflowInputSchema.parse({ expression: 'a', start_prompt: 'hi', provider: '-abc' })).toThrow();
  });

  it('provider with internal hyphens (a-b-c) is accepted', () => {
    const parsed = workflowInputSchema.parse({ expression: 'a', start_prompt: 'hi', provider: 'a-b-c' });
    expect(parsed.provider).toBe('a-b-c');
  });

  it('empty string provider is rejected', () => {
    expect(() => workflowInputSchema.parse({ expression: 'a', start_prompt: 'hi', provider: '' })).toThrow();
  });

  it('provider with uppercase letter is rejected', () => {
    expect(() => workflowInputSchema.parse({ expression: 'a', start_prompt: 'hi', provider: 'Claude' })).toThrow();
  });

  it('provider with underscore is rejected (providerIdentPattern excludes underscores)', () => {
    expect(() => workflowInputSchema.parse({ expression: 'a', start_prompt: 'hi', provider: 'my_provider' })).toThrow();
  });
});
