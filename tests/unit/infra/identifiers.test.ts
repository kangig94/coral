import { describe, expect, it } from 'vitest';

import {
  AGENT_IDENT_RE,
  assertOwnerId,
  identPattern,
  isOwnerId,
  nonEmptyStringSchema,
  providerIdentPattern,
  readNonEmptyString,
} from '#src/infra/identifiers.js';

describe('infra identifiers', () => {
  describe('identPattern', () => {
    it.each(['a', 'A', '0', 'agent-1', 'team.alpha', 'a_b-c.d', 'A1.b_C-9'])('should match %j', (value) => {
      expect(identPattern.test(value)).toBe(true);
    });

    it.each(['', '.a', '-a', '_a', 'a b', 'a/b', 'a:b', 'ü', ' a', 'a\n'])('should reject %j', (value) => {
      expect(identPattern.test(value)).toBe(false);
    });
  });

  describe('providerIdentPattern', () => {
    it.each(['codex', 'claude', 'claude-3', 'a', 'a0-b1'])('should match %j', (value) => {
      expect(providerIdentPattern.test(value)).toBe(true);
    });

    it.each(['', 'Codex', '3x', '-codex', 'a_b', 'a.b', 'a b'])('should reject %j', (value) => {
      expect(providerIdentPattern.test(value)).toBe(false);
    });
  });

  describe('AGENT_IDENT_RE', () => {
    it.each(['agent', 'a', '0agent', 'my-agent', 'coral:critic', 'ns-1:agent-2'])('should match %j', (value) => {
      expect(AGENT_IDENT_RE.test(value)).toBe(true);
    });

    it.each(['', ':agent', 'agent:', 'Ns:agent', 'ns:Agent', 'a:b:c', '-agent', 'ns:-agent', 'a_b'])(
      'should reject %j',
      (value) => {
        expect(AGENT_IDENT_RE.test(value)).toBe(false);
      },
    );
  });

  describe('nonEmptyStringSchema', () => {
    it('should accept a non-empty string', () => {
      expect(nonEmptyStringSchema.parse('x')).toBe('x');
    });

    it('should reject the empty string', () => {
      expect(nonEmptyStringSchema.safeParse('').success).toBe(false);
    });

    it('should reject non-string values', () => {
      expect(nonEmptyStringSchema.safeParse(42).success).toBe(false);
      expect(nonEmptyStringSchema.safeParse(null).success).toBe(false);
    });
  });

  describe('readNonEmptyString', () => {
    it('should return the string when non-empty', () => {
      expect(readNonEmptyString('value')).toBe('value');
    });

    it.each([null, undefined, ''])('should return undefined for %j', (value) => {
      expect(readNonEmptyString(value)).toBeUndefined();
    });

    it('should return whitespace-only strings unchanged (length check only, no trim)', () => {
      expect(readNonEmptyString('  ')).toBe('  ');
    });
  });

  describe('isOwnerId', () => {
    it('should accept token-safe identifier strings', () => {
      expect(isOwnerId('owner-1')).toBe(true);
      expect(isOwnerId('a.b_c-d')).toBe(true);
    });

    it('should reject non-string values', () => {
      expect(isOwnerId(42)).toBe(false);
      expect(isOwnerId(null)).toBe(false);
      expect(isOwnerId(undefined)).toBe(false);
      expect(isOwnerId({})).toBe(false);
    });

    it('should reject strings that violate the identifier pattern', () => {
      expect(isOwnerId('')).toBe(false);
      expect(isOwnerId('-owner')).toBe(false);
      expect(isOwnerId('owner id')).toBe(false);
    });
  });

  describe('assertOwnerId', () => {
    it('should return the value for a valid owner id', () => {
      expect(assertOwnerId('owner-1')).toBe('owner-1');
    });

    it('should throw with the default label for invalid values', () => {
      expect(() => assertOwnerId('')).toThrow(/owner must be a non-empty token-safe identifier/);
    });

    it('should include the custom label in the error message', () => {
      expect(() => assertOwnerId('bad id', 'agent')).toThrow(/agent must be a non-empty token-safe identifier/);
    });

    it.each(['.leading-dot', '-leading-dash', '_leading-underscore', 'has space', 'has/slash'])(
      'should throw for %j',
      (value) => {
        expect(() => assertOwnerId(value)).toThrow();
      },
    );

    it('should throw for non-string values', () => {
      expect(() => assertOwnerId(42)).toThrow();
      expect(() => assertOwnerId(null)).toThrow();
    });
  });
});
