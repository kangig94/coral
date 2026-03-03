import { describe, expect, it } from 'vitest';
import { parseExpression } from '../pipe-parser.js';

describe('workflow pipe parser', () => {
  it('parses a single atom', () => {
    expect(parseExpression('architect')).toEqual([[{ namespace: undefined, agent: 'architect', provider: undefined }]]);
  });

  it('parses sequential atoms', () => {
    expect(parseExpression('architect -> resolver')).toEqual([
      [{ namespace: undefined, agent: 'architect', provider: undefined }],
      [{ namespace: undefined, agent: 'resolver', provider: undefined }],
    ]);
  });

  it('parses a parallel group followed by single atom', () => {
    expect(parseExpression('(architect, critic) -> resolver')).toEqual([
      [
        { namespace: undefined, agent: 'architect', provider: undefined },
        { namespace: undefined, agent: 'critic', provider: undefined },
      ],
      [{ namespace: undefined, agent: 'resolver', provider: undefined }],
    ]);
  });

  it('parses long sequential chains', () => {
    expect(parseExpression('a -> b -> c -> d')).toEqual([
      [{ namespace: undefined, agent: 'a', provider: undefined }],
      [{ namespace: undefined, agent: 'b', provider: undefined }],
      [{ namespace: undefined, agent: 'c', provider: undefined }],
      [{ namespace: undefined, agent: 'd', provider: undefined }],
    ]);
  });

  it('parses per-atom provider overrides', () => {
    expect(parseExpression('architect@claude -> resolver@codex')).toEqual([
      [{ namespace: undefined, agent: 'architect', provider: 'claude' }],
      [{ namespace: undefined, agent: 'resolver', provider: 'codex' }],
    ]);
  });

  it('parses explicit namespaces', () => {
    expect(parseExpression('coral:architect -> some-plugin:critic')).toEqual([
      [{ namespace: 'coral', agent: 'architect', provider: undefined }],
      [{ namespace: 'some-plugin', agent: 'critic', provider: undefined }],
    ]);
  });

  it('supports whitespace around tokens', () => {
    expect(parseExpression(' ( architect , critic ) -> resolver ')).toEqual([
      [
        { namespace: undefined, agent: 'architect', provider: undefined },
        { namespace: undefined, agent: 'critic', provider: undefined },
      ],
      [{ namespace: undefined, agent: 'resolver', provider: undefined }],
    ]);
  });

  it('accepts single atom inside parentheses', () => {
    expect(parseExpression('(architect)')).toEqual([
      [{ namespace: undefined, agent: 'architect', provider: undefined }],
    ]);
  });

  it('allows same atom name across different steps', () => {
    expect(parseExpression('architect -> architect@claude')).toEqual([
      [{ namespace: undefined, agent: 'architect', provider: undefined }],
      [{ namespace: undefined, agent: 'architect', provider: 'claude' }],
    ]);
  });

  it('rejects empty expressions', () => {
    expect(() => parseExpression('')).toThrow('Expression required');
  });

  it('rejects leading arrow', () => {
    expect(() => parseExpression('-> resolver')).toThrow('Expected step expression before "->"');
  });

  it('rejects trailing arrow', () => {
    expect(() => parseExpression('architect ->')).toThrow('Expected step expression after "->"');
  });

  it('rejects empty parallel groups', () => {
    expect(() => parseExpression('()')).toThrow('Parallel group cannot be empty');
  });

  it('rejects nested groups', () => {
    expect(() => parseExpression('((a, b))')).toThrow('Nested groups are not allowed');
  });

  it('rejects uppercase names', () => {
    expect(() => parseExpression('Architect')).toThrow('Invalid agent "Architect"');
  });

  it('rejects names that start with digits', () => {
    expect(() => parseExpression('1architect')).toThrow('Invalid agent "1architect"');
  });

  it('rejects underscores in names', () => {
    expect(() => parseExpression('arch_tect')).toThrow('Invalid agent "arch_tect"');
  });

  it('rejects empty agent after namespace', () => {
    expect(() => parseExpression('coral:')).toThrow('Expected agent name after ":"');
  });

  it('rejects traversal-like names', () => {
    expect(() => parseExpression('coral:../x')).toThrow('Invalid agent "../x"');
  });

  it('rejects unknown provider suffixes', () => {
    expect(() => parseExpression('architect@unknown')).toThrow('Unknown provider "unknown"');
  });

  it('rejects duplicate atom names in same parallel step', () => {
    expect(() => parseExpression('(architect, architect@claude)')).toThrow('Duplicate atom "architect"');
  });

  it('arrow embedded in parallel group yields atom error, not a structure error', () => {
    expect(() => parseExpression('(a -> b)')).toThrow('Invalid agent');
  });

  it('rejects empty namespace before colon (:agent)', () => {
    expect(() => parseExpression(':agent')).toThrow('Expected namespace before ":"');
  });

  it('rejects multiple colons in qualified name (a:b:c)', () => {
    expect(() => parseExpression('a:b:c')).toThrow('Invalid atom');
  });

  it('rejects multiple @ signs (a@@claude)', () => {
    expect(() => parseExpression('a@@claude')).toThrow('Invalid atom');
  });

  it('rejects provider-only atom with no agent name before @ (@claude)', () => {
    expect(() => parseExpression('@claude')).toThrow('Expected agent name in');
  });

  it('rejects whitespace-only expression', () => {
    expect(() => parseExpression('   ')).toThrow('Expression required');
  });

  it('rejects double-arrow producing empty step between arrows (a -> -> b)', () => {
    expect(() => parseExpression('a -> -> b')).toThrow('Expected step expression');
  });

  it('rejects comma outside of parentheses (a, b -> c)', () => {
    expect(() => parseExpression('a, b -> c')).toThrow('Parallel steps must be wrapped in parentheses');
  });

  it('rejects unmatched ) without opener (a -> b))', () => {
    expect(() => parseExpression('a -> b)')).toThrow('Unmatched ")"');
  });

  it('parses tight arrow without spaces (architect->resolver)', () => {
    const ast = parseExpression('architect->resolver');
    expect(ast).toHaveLength(2);
    expect(ast[0][0].agent).toBe('architect');
    expect(ast[1][0].agent).toBe('resolver');
  });

  it('rejects empty provider text after @ (architect@)', () => {
    expect(() => parseExpression('architect@')).toThrow('Expected provider after "@"');
  });
});
