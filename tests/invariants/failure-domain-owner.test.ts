import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { listProductionSourceFiles } from '#tests/helpers/ts-import-scanner.js';

// Paths assembled from split fragments are outside this invariant's scope.
const CONTROLLED_TOKENS =
  /\/sys\/fs\/cgroup|\bcgroup\.[a-z_]+\b|memory\.oom\.group|oom_score_adj|StartTransientUnit|AttachProcessesToUnit/;

it('keeps all controlled-token occurrences in the failure-domain owner', () => {
  const violations = listProductionSourceFiles(resolve('src'))
    .filter((path) => relative(process.cwd(), path) !== 'src/infra/failure-domain.ts')
    .filter((path) => CONTROLLED_TOKENS.test(readFileSync(path, 'utf8')))
    .map((path) => relative(process.cwd(), path));
  expect(violations).toEqual([]);
});
