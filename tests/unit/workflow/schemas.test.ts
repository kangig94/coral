import { describe, expect, it } from 'vitest';
import { workflowCommandSchema } from '#src/workflow/api.js';

describe('workflowCommandSchema', () => {
  it('accepts minimal valid input and defaults provider to claude', () => {
    const parsed = workflowCommandSchema.parse({
      expression: 'architect -> resolver',
      startPrompt: 'hello',
    });

    expect(parsed.provider).toBe('claude');
  });

  it('accepts optional context string', () => {
    const parsed = workflowCommandSchema.parse({
      expression: 'architect -> resolver',
      startPrompt: 'hello',
      context: 'Shared briefing',
    });

    expect(parsed.context).toBe('Shared briefing');
  });

  it('rejects missing expression', () => {
    expect(() => workflowCommandSchema.parse({ startPrompt: 'hello' })).toThrow();
  });

  it('rejects missing startPrompt', () => {
    expect(() => workflowCommandSchema.parse({ expression: 'architect' })).toThrow();
  });

  it('rejects empty expression', () => {
    expect(() => workflowCommandSchema.parse({ expression: '', startPrompt: 'hello' })).toThrow('Expression required');
  });

  it('rejects empty startPrompt', () => {
    expect(() => workflowCommandSchema.parse({ expression: 'architect', startPrompt: '' })).toThrow('Prompt required');
  });

  it('accepts provider identifiers beyond built-in providers', () => {
    const parsed = workflowCommandSchema.parse({
      expression: 'architect',
      startPrompt: 'hello',
      provider: 'openai',
    });
    expect(parsed.provider).toBe('openai');
  });

  it('rejects invalid provider identifier syntax', () => {
    expect(() =>
      workflowCommandSchema.parse({
        expression: 'architect',
        startPrompt: 'hello',
        provider: 'OpenAI',
      }),
    ).toThrow();
  });

  it('rejects legacy top-level args key', () => {
    expect(() =>
      workflowCommandSchema.parse({
        expression: 'architect',
        startPrompt: 'hello',
        args: {},
      }),
    ).toThrow(/Unrecognized key\(s\) in object: 'args'/);
  });

  it('rejects legacy top-level prompt key', () => {
    const parsed = workflowCommandSchema.safeParse({
      expression: 'architect',
      startPrompt: 'hello',
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
      workflowCommandSchema.parse({
        expression: 'architect',
        startPrompt: 'hello',
        atoms: { architect: { instruction: 'focus' } },
      }),
    ).toThrow(/Unrecognized key\(s\) in object: 'atoms'/);
  });

  it('rejects removed stale_timeout_seconds field', () => {
    expect(() =>
      workflowCommandSchema.parse({
        expression: 'architect',
        startPrompt: 'hello',
        stale_timeout_seconds: 900,
      }),
    ).toThrow(/Unrecognized key\(s\) in object: 'stale_timeout_seconds'/);
  });

  it('rejects legacy start_prompt under strict mode', () => {
    expect(() =>
      workflowCommandSchema.parse({
        expression: 'architect',
        start_prompt: 'hello',
      }),
    ).toThrow(/Unrecognized key\(s\) in object: 'start_prompt'/);
  });

  it('rejects legacy work_dir under strict mode', () => {
    expect(() =>
      workflowCommandSchema.parse({
        expression: 'architect',
        startPrompt: 'hello',
        work_dir: '/tmp/legacy',
      }),
    ).toThrow(/Unrecognized key\(s\) in object: 'work_dir'/);
  });

  it('rejects provider: null', () => {
    expect(() => workflowCommandSchema.parse({ expression: 'a', startPrompt: 'hi', provider: null })).toThrow();
  });
});

describe('provider identifier boundary values', () => {
  it('single lowercase letter is a valid provider identifier', () => {
    const parsed = workflowCommandSchema.parse({ expression: 'a', startPrompt: 'hi', provider: 'a' });
    expect(parsed.provider).toBe('a');
  });

  it('provider starting with digit is rejected', () => {
    expect(() => workflowCommandSchema.parse({ expression: 'a', startPrompt: 'hi', provider: '1abc' })).toThrow();
  });

  it('provider starting with hyphen is rejected', () => {
    expect(() => workflowCommandSchema.parse({ expression: 'a', startPrompt: 'hi', provider: '-abc' })).toThrow();
  });

  it('provider with internal hyphens (a-b-c) is accepted', () => {
    const parsed = workflowCommandSchema.parse({ expression: 'a', startPrompt: 'hi', provider: 'a-b-c' });
    expect(parsed.provider).toBe('a-b-c');
  });

  it('empty string provider is rejected', () => {
    expect(() => workflowCommandSchema.parse({ expression: 'a', startPrompt: 'hi', provider: '' })).toThrow();
  });

  it('provider with uppercase letter is rejected', () => {
    expect(() => workflowCommandSchema.parse({ expression: 'a', startPrompt: 'hi', provider: 'Claude' })).toThrow();
  });

  it('provider with underscore is rejected (providerIdentPattern excludes underscores)', () => {
    expect(() => workflowCommandSchema.parse({ expression: 'a', startPrompt: 'hi', provider: 'my_provider' })).toThrow();
  });
});
