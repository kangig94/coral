import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles, toCanonicalSrcPath } from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_ROOT = resolve(REPO_ROOT, 'src');
const RETIRED_IDLE_RETIREMENT_VALUE = /(['"`])(?:host-reported|none)\1/u;

function retiredIdleRetirementValues(): string[] {
  const violations: string[] = [];

  for (const filePath of listProductionSourceFiles(SRC_ROOT)) {
    const canonicalPath = toCanonicalSrcPath(REPO_ROOT, filePath);
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (!line.includes('idleRetirement') || !RETIRED_IDLE_RETIREMENT_VALUE.test(line)) return;
      violations.push(`${canonicalPath}:${index + 1}:${line.trim()}`);
    });
  }

  return violations;
}

describe('idle retirement vocabulary', () => {
  it('keeps retired value spellings out of production idleRetirement lines', () => {
    expect(retiredIdleRetirementValues()).toEqual([]);
  });
});
