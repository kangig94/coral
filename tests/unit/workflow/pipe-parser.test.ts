import { describe, expect, it } from 'vitest';
import { parseExpression } from '#src/workflow/parser.js';

describe('workflow pipe parser', () => {
  it('parses sequential atoms', () => {
    expect(parseExpression('architect -> resolver')).toEqual([
      [{ kind: 'agent', namespace: undefined, agent: 'architect', provider: undefined }],
      [{ kind: 'agent', namespace: undefined, agent: 'resolver', provider: undefined }],
    ]);
  });

  it('parses a parallel group followed by single atom', () => {
    expect(parseExpression('(architect, critic) -> resolver')).toEqual([
      [
        { kind: 'agent', namespace: undefined, agent: 'architect', provider: undefined },
        { kind: 'agent', namespace: undefined, agent: 'critic', provider: undefined },
      ],
      [{ kind: 'agent', namespace: undefined, agent: 'resolver', provider: undefined }],
    ]);
  });

  it('parses per-atom provider overrides', () => {
    expect(parseExpression('architect@claude -> resolver@codex')).toEqual([
      [{ kind: 'agent', namespace: undefined, agent: 'architect', provider: 'claude' }],
      [{ kind: 'agent', namespace: undefined, agent: 'resolver', provider: 'codex' }],
    ]);
  });

  it('parses single-quoted prompt literal', () => {
    expect(parseExpression("'summarize'")).toEqual([[{ kind: 'prompt', text: 'summarize', provider: undefined }]]);
  });

  it('handles commas inside quoted prompt literal in parallel group', () => {
    expect(parseExpression("('do a, b', architect)")).toEqual([
      [
        { kind: 'prompt', text: 'do a, b', provider: undefined },
        { kind: 'agent', namespace: undefined, agent: 'architect', provider: undefined },
      ],
    ]);
  });

  it('handles escaped double quote inside double-quoted prompt literal', () => {
    const ast = parseExpression('"say \\"hello\\""');
    expect(ast[0][0]).toEqual({ kind: 'prompt', text: 'say "hello"', provider: undefined });
  });

  it('rejects empty prompt literal (single quote)', () => {
    expect(() => parseExpression("''")).toThrow();
  });

  it('rejects unclosed quote', () => {
    expect(() => parseExpression("'unclosed")).toThrow();
  });

  it('rejects empty expressions', () => {
    expect(() => parseExpression('')).toThrow();
  });

  it('rejects leading arrow', () => {
    expect(() => parseExpression('-> resolver')).toThrow();
  });

  it('rejects nested groups', () => {
    expect(() => parseExpression('((a, b))')).toThrow();
  });

  it('rejects traversal-like names', () => {
    expect(() => parseExpression('coral:../x')).toThrow();
  });

  it('rejects comma outside of parentheses (a, b -> c)', () => {
    expect(() => parseExpression('a, b -> c')).toThrow();
  });

  it('rejects unmatched ) without opener (a -> b))', () => {
    expect(() => parseExpression('a -> b)')).toThrow();
  });
});
