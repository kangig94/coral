import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { listProductionSourceFiles, toCanonicalSrcPath } from '#tests/helpers/ts-import-scanner.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC_ROOT = join(REPO_ROOT, 'src');
const SESSION_SHELL = 'src/sessions/shell.ts';

describe('session local commit invariant', () => {
  it('keeps createLocalSessionCommit isolated from production callers', () => {
    const productionFiles = listProductionSourceFiles(SRC_ROOT);
    const localCommitMentions = productionFiles
      .map((filePath) => ({
        filePath,
        canonical: toCanonicalSrcPath(REPO_ROOT, filePath),
        source: readFileSync(filePath, 'utf8'),
      }))
      .filter(({ canonical }) => canonical !== SESSION_SHELL)
      .filter(({ source }) => source.includes('createLocalSessionCommit'))
      .map(({ canonical }) => canonical);

    const productionFallbackCallers = productionFiles
      .map((filePath) => ({
        canonical: toCanonicalSrcPath(REPO_ROOT, filePath),
        source: readFileSync(filePath, 'utf8'),
      }))
      .filter(({ source }) => /SessionManager\.forProduction\([\s\S]{0,240}\bundefined\b/.test(source))
      .map(({ canonical }) => canonical);

    expect(localCommitMentions).toEqual([]);
    expect(productionFallbackCallers).toEqual([]);
  });
});
