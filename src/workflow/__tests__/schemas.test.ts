import { describe, expect, it } from 'vitest';
import { workflowInputSchema } from '../schemas.js';

describe('workflowInputSchema', () => {
  it('accepts minimal valid input and defaults provider to codex', () => {
    const parsed = workflowInputSchema.parse({
      expression: 'architect -> resolver',
      prompt: 'hello',
    });

    expect(parsed.provider).toBe('codex');
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

  it('rejects invalid provider values', () => {
    expect(() => workflowInputSchema.parse({
      expression: 'architect',
      prompt: 'hello',
      provider: 'openai',
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
