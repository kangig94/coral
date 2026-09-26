import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles, toCanonicalSrcPath } from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

/**
 * A store mint discards the incumbent epoch's claim to be current, so its authority is the coordinator's startup
 * retirement decision alone: any other constructor of a disposition could mint over work nobody settled.
 */
const MINT_AUTHORITY_FILES = new Set(['src/store/epoch.ts', 'src/coordinator/services/startup-retirement.ts']);

describe('retirement mint authority', () => {
  it('should construct a store mint disposition only in startup retirement', () => {
    const mentions = listProductionSourceFiles(resolve(REPO_ROOT, 'src'))
      .filter((file) => /\bretirementMintDisposition\b/u.test(readFileSync(file, 'utf8')))
      .map((file) => toCanonicalSrcPath(REPO_ROOT, file))
      .sort();

    expect(mentions).toEqual([...MINT_AUTHORITY_FILES].sort());
  });
});
