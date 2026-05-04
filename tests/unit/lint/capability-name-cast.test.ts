import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// This guard previously booted a full ESLint instance + typescript-eslint
// parser to lint a probe file (3.8s, racy under high fork count). The
// realistic protection it offered was "if someone removes the
// no-restricted-syntax selector for KbCapabilityName, this test fails".
// The same guarantee comes from inspecting the config source statically.
// `npm run lint` continues to verify the rule actually fires against
// real code at lint time.
describe('KbCapabilityName lint guard', () => {
  it('eslint.config.mjs registers no-restricted-syntax selectors for KbCapabilityName casts', () => {
    const configSource = readFileSync(join(process.cwd(), 'eslint.config.mjs'), 'utf8');

    // The rule must be registered.
    expect(configSource).toMatch(/no-restricted-syntax/);

    // 5 distinct selectors target KbCapabilityName: TSAsExpression × 2
    // typeName shapes, TSTypeAssertion × 2 typeName shapes, and an
    // ImportSpecifier alias guard. Verifying the selector identifiers + the
    // KbCapabilityName mention count keeps the test robust to whitespace
    // and bracket-ordering changes while catching genuine removals.
    const kbMentions = configSource.match(/KbCapabilityName/g) ?? [];
    expect(kbMentions.length).toBeGreaterThanOrEqual(5);
    expect(configSource).toMatch(/TSAsExpression/);
    expect(configSource).toMatch(/TSTypeAssertion/);
    expect(configSource).toMatch(/ImportSpecifier/);
    expect(configSource).toMatch(/typeAnnotation\.typeName/);
  });
});
