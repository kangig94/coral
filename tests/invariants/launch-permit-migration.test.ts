import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles } from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SOURCE_FILES = listProductionSourceFiles(resolve(REPO_ROOT, 'src'));
const SOURCE = SOURCE_FILES.map((path) => readFileSync(path, 'utf8')).join('\n');
describe('launch permit migration constraints', () => {
  it('keeps one exact release signature and removes legacy ownership shortcuts', () => {
    const declarations = [
      ...SOURCE.matchAll(/\breleaseLaunch\s*\(([^)]*:[^)]*)\)\s*(?::\s*LaunchRelease)?\s*[;{]/gu),
    ].map((match) => match[1]?.replace(/\s+/gu, ' ').trim());

    expect(new Set(declarations)).toEqual(new Set(['permit: LaunchPermit']));
    for (const legacyName of ['releaseByAbortAuthority', 'jobPools', 'permitAcquired', 'preserveOwnership']) {
      expect(SOURCE).not.toMatch(new RegExp(`\\b${legacyName}\\b`, 'u'));
    }
  });
});
