import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles } from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SOURCE_FILES = listProductionSourceFiles(resolve(REPO_ROOT, 'src'));
const SOURCE = SOURCE_FILES.map((path) => readFileSync(path, 'utf8')).join('\n');
describe('launch permit migration constraints', () => {
  it('removes legacy ownership shortcuts', () => {
    // A retired ownership path must not return under its old name; design philosophy §1 requires the deleted path to be guarded.
    for (const legacyName of ['releaseByAbortAuthority', 'jobPools', 'permitAcquired', 'preserveOwnership']) {
      expect(SOURCE).not.toMatch(new RegExp(`\\b${legacyName}\\b`, 'u'));
    }
  });
});
