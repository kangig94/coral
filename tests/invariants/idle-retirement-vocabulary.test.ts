import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles, toCanonicalSrcPath } from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_ROOT = resolve(REPO_ROOT, 'src');
const RETIRED_IDLE_RETIREMENT_VALUE = /(['"`])(?:host-reported|none)\1/u;
const IDLE_RETIREMENT_VALUE_WINDOW_LINES = 8;

function retiredIdleRetirementValuesInSource(source: string, canonicalPath: string): string[] {
  const violations: string[] = [];
  const lines = source.split(/\r?\n/u);

  lines.forEach((line, index) => {
    if (!line.includes('idleRetirement')) return;
    const window = lines.slice(index, index + IDLE_RETIREMENT_VALUE_WINDOW_LINES);
    const retiredValueOffset = window.findIndex((candidate) => RETIRED_IDLE_RETIREMENT_VALUE.test(candidate));
    if (retiredValueOffset === -1) return;
    const retiredValueLine = window[retiredValueOffset];
    violations.push(`${canonicalPath}:${index + retiredValueOffset + 1}:${retiredValueLine.trim()}`);
  });

  return violations;
}

function retiredIdleRetirementValues(): string[] {
  const violations: string[] = [];

  for (const filePath of listProductionSourceFiles(SRC_ROOT)) {
    const canonicalPath = toCanonicalSrcPath(REPO_ROOT, filePath);
    violations.push(...retiredIdleRetirementValuesInSource(readFileSync(filePath, 'utf8'), canonicalPath));
  }

  return violations;
}

describe('idle retirement vocabulary', () => {
  it('keeps retired value spellings out of production idleRetirement lines', () => {
    expect(retiredIdleRetirementValues()).toEqual([]);
  });

  it.each([
    [
      'object literal',
      `const spec = {
  idleRetirement:
    'none',
};`,
      "fixture.ts:3:'none',",
    ],
    [
      'schema enum',
      `const schema = {
  idleRetirement: z.enum([
    'unleased',
    'host-reported',
  ]),
};`,
      "fixture.ts:4:'host-reported',",
    ],
    [
      'union',
      `type Policy = {
  idleRetirement:
    | 'unleased'
    | 'none';
};`,
      "fixture.ts:4:| 'none';",
    ],
  ])('catches retired values in a multiline %s', (_shape, source, expected) => {
    expect(retiredIdleRetirementValuesInSource(source, 'fixture.ts')).toContain(expected);
  });
});
