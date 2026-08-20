import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('KbCapabilityName lint guard', () => {
  it('eslint.config.mjs registers no-restricted-syntax selectors for KbCapabilityName casts', () => {
    const configSource = readFileSync(join(process.cwd(), 'eslint.config.mjs'), 'utf8');

    expect(configSource).toMatch(/no-restricted-syntax/);

    // Verifying the selector identifiers + the
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
