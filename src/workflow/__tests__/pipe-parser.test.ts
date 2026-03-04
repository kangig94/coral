import { describe, expect, it } from 'vitest';
import { parseExpression } from '../pipe-parser.js';

describe('workflow pipe parser', () => {
  it('parses a single atom', () => {
    expect(parseExpression('architect')).toEqual([[
      { kind: 'agent', namespace: undefined, agent: 'architect', provider: undefined },
    ]]);
  });

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

  it('parses long sequential chains', () => {
    expect(parseExpression('a -> b -> c -> d')).toEqual([
      [{ kind: 'agent', namespace: undefined, agent: 'a', provider: undefined }],
      [{ kind: 'agent', namespace: undefined, agent: 'b', provider: undefined }],
      [{ kind: 'agent', namespace: undefined, agent: 'c', provider: undefined }],
      [{ kind: 'agent', namespace: undefined, agent: 'd', provider: undefined }],
    ]);
  });

  it('parses per-atom provider overrides', () => {
    expect(parseExpression('architect@claude -> resolver@codex')).toEqual([
      [{ kind: 'agent', namespace: undefined, agent: 'architect', provider: 'claude' }],
      [{ kind: 'agent', namespace: undefined, agent: 'resolver', provider: 'codex' }],
    ]);
  });

  it('parses explicit namespaces', () => {
    expect(parseExpression('coral:architect -> some-plugin:critic')).toEqual([
      [{ kind: 'agent', namespace: 'coral', agent: 'architect', provider: undefined }],
      [{ kind: 'agent', namespace: 'some-plugin', agent: 'critic', provider: undefined }],
    ]);
  });

  it('supports whitespace around tokens', () => {
    expect(parseExpression(' ( architect , critic ) -> resolver ')).toEqual([
      [
        { kind: 'agent', namespace: undefined, agent: 'architect', provider: undefined },
        { kind: 'agent', namespace: undefined, agent: 'critic', provider: undefined },
      ],
      [{ kind: 'agent', namespace: undefined, agent: 'resolver', provider: undefined }],
    ]);
  });

  it('accepts single atom inside parentheses', () => {
    expect(parseExpression('(architect)')).toEqual([
      [{ kind: 'agent', namespace: undefined, agent: 'architect', provider: undefined }],
    ]);
  });

  it('allows same atom name across different steps', () => {
    expect(parseExpression('architect -> architect@claude')).toEqual([
      [{ kind: 'agent', namespace: undefined, agent: 'architect', provider: undefined }],
      [{ kind: 'agent', namespace: undefined, agent: 'architect', provider: 'claude' }],
    ]);
  });

  it('allows same agent name with different providers in parallel group', () => {
    expect(parseExpression('(architect, architect@claude)')).toEqual([[
      { kind: 'agent', namespace: undefined, agent: 'architect', provider: undefined },
      { kind: 'agent', namespace: undefined, agent: 'architect', provider: 'claude' },
    ]]);
  });

  it('parses single-quoted prompt literal', () => {
    expect(parseExpression('\'summarize\'')).toEqual([[
      { kind: 'prompt', text: 'summarize', provider: undefined },
    ]]);
  });

  it('parses double-quoted prompt literal', () => {
    expect(parseExpression('"summarize"')).toEqual([[
      { kind: 'prompt', text: 'summarize', provider: undefined },
    ]]);
  });

  it('parses prompt literal with @provider override', () => {
    expect(parseExpression('\'text\'@claude')).toEqual([[
      { kind: 'prompt', text: 'text', provider: 'claude' },
    ]]);
  });

  it('parses prompt literal in parallel group with agent', () => {
    expect(parseExpression('(architect, \'summarize\')')).toEqual([[
      { kind: 'agent', namespace: undefined, agent: 'architect', provider: undefined },
      { kind: 'prompt', text: 'summarize', provider: undefined },
    ]]);
  });

  it('parses prompt literal as middle step in chain', () => {
    const ast = parseExpression('architect -> \'summarize\' -> resolver');
    expect(ast).toHaveLength(3);
    expect(ast[1][0]).toEqual({ kind: 'prompt', text: 'summarize', provider: undefined });
  });

  it('handles embedded alternate quotes in prompt literal', () => {
    const ast = parseExpression('\'say "hello"\'');
    expect(ast[0][0]).toEqual({ kind: 'prompt', text: 'say "hello"', provider: undefined });
  });

  it('handles commas inside quoted prompt literal in parallel group', () => {
    expect(parseExpression('(\'do a, b\', architect)')).toEqual([[
      { kind: 'prompt', text: 'do a, b', provider: undefined },
      { kind: 'agent', namespace: undefined, agent: 'architect', provider: undefined },
    ]]);
  });

  it('handles commas inside quoted prompt literal in single-step chain', () => {
    const ast = parseExpression('\'do a, b\' -> resolver');
    expect(ast).toHaveLength(2);
    expect(ast[0][0]).toEqual({ kind: 'prompt', text: 'do a, b', provider: undefined });
  });

  it('handles -> inside quoted prompt literal', () => {
    const ast = parseExpression('\'use -> arrows\' -> architect');
    expect(ast).toHaveLength(2);
    expect(ast[0][0]).toEqual({ kind: 'prompt', text: 'use -> arrows', provider: undefined });
  });

  it('handles parentheses inside quoted prompt literal in parallel group', () => {
    const ast = parseExpression('(\'run (debug)\', architect)');
    expect(ast[0][0]).toEqual({ kind: 'prompt', text: 'run (debug)', provider: undefined });
  });

  it('rejects empty prompt literal (single quote)', () => {
    expect(() => parseExpression('\'\'')).toThrow('Empty prompt literal');
  });

  it('rejects empty prompt literal (double quote)', () => {
    expect(() => parseExpression('""')).toThrow('Empty prompt literal');
  });

  it('rejects unclosed quote', () => {
    expect(() => parseExpression('\'unclosed')).toThrow('Unclosed quote');
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

  it('accepts provider suffixes that match provider identifier syntax', () => {
    expect(parseExpression('architect@unknown')).toEqual([
      [{ kind: 'agent', namespace: undefined, agent: 'architect', provider: 'unknown' }],
    ]);
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
    expect(ast[0][0].kind).toBe('agent');
    if (ast[0][0].kind === 'agent') {
      expect(ast[0][0].agent).toBe('architect');
    }
    expect(ast[1][0].kind).toBe('agent');
    if (ast[1][0].kind === 'agent') {
      expect(ast[1][0].agent).toBe('resolver');
    }
  });

  it('rejects empty provider text after @ (architect@)', () => {
    expect(() => parseExpression('architect@')).toThrow('Expected provider after "@"');
  });
});

describe('@provider suffix boundary values', () => {
  it('@a (single lowercase char) is accepted as a valid provider suffix', () => {
    const ast = parseExpression('architect@a');
    expect(ast[0][0]).toMatchObject({ kind: 'agent', provider: 'a' });
  });

  it('@1bad (digit start) is rejected by the provider pattern', () => {
    expect(() => parseExpression('architect@1bad')).toThrow(/Unknown provider/i);
  });

  it('@Claude (uppercase start) is rejected by the provider pattern', () => {
    expect(() => parseExpression('architect@Claude')).toThrow(/Unknown provider/i);
  });

  it('@-bad (hyphen start) is rejected by the provider pattern', () => {
    expect(() => parseExpression('architect@-bad')).toThrow(/Unknown provider/i);
  });

  it('@abc- (trailing hyphen) is accepted — providerIdentPattern allows trailing hyphen', () => {
    expect(() => parseExpression('architect@abc-')).not.toThrow();
    const ast = parseExpression('architect@abc-');
    expect(ast[0][0]).toMatchObject({ kind: 'agent', provider: 'abc-' });
  });
});
