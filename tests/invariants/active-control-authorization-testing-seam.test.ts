// `mintActiveControlAuthorizationForTesting` (src/provider-proxy/control-endpoint.ts) exists so a harness
// that drives a role's `active` handler directly — with no live tenancy of its own to admit one — can present
// a genuine `ActiveControlAuthorization` instead of casting a same-shaped value into the brand. If production
// code ever called it, the unforgeability `activeControlAuthorizationIsCurrent` depends on would stop holding
// the instant that call landed, and nothing else would notice: the function still returns a well-typed value,
// a real call site keeps `knip` quiet, and there is no runtime check anywhere else in the system that a
// minted authorization came from `dispatch`'s own admission rather than from this seam. This file is what
// notices instead.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listProductionSourceFiles, toCanonicalSrcPath } from '#tests/helpers/ts-import-scanner.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');
const MINTING_SEAM = 'mintActiveControlAuthorizationForTesting';
const OWNING_MODULE = 'src/provider-proxy/control-endpoint.ts';

describe('active-control-authorization testing seam', () => {
  it('is referenced only by the module that defines it', () => {
    const referencing = listProductionSourceFiles(SRC_ROOT)
      .filter((filePath) => readFileSync(filePath, 'utf-8').includes(MINTING_SEAM))
      .map((filePath) => toCanonicalSrcPath(REPO_ROOT, filePath))
      .sort();

    expect(referencing).toEqual([OWNING_MODULE]);
  });
});
