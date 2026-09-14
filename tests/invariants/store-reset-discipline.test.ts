import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isGarbageStoreEpoch } from '#src/store/epoch.js';

const ROOT = process.cwd();

function source(path: string): string {
  return readFileSync(join(ROOT, path), 'utf-8');
}

function storeSources(): readonly string[] {
  return readdirSync(join(ROOT, 'src/store'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `src/store/${name}`);
}

describe('write-once store epoch invariants', () => {
  it('publishes an epoch directory only by renaming a private mint', () => {
    const epoch = source('src/store/epoch.ts');
    expect(epoch.match(/renameSync\([^)]*epochDirectory/g)).toEqual(['renameSync(mint, epochDirectory']);
    expect(epoch).toContain("const MINT_DIRECTORY_PREFIX = '.mint-'");
  });

  it('keeps epoch deletion inside the sweep implementation', () => {
    for (const path of storeSources()) {
      if (path === 'src/store/epoch.ts') continue;
      expect(source(path), path).not.toMatch(/(?:rmSync|unlinkSync)\([^\n]*epoch-/u);
    }
    const epoch = source('src/store/epoch.ts');
    expect(epoch).toMatch(/function sweepStoreEpochs[\s\S]*removeDuringSweep/u);
  });

  it('classifies exactly K <= current - 2 as garbage', () => {
    for (let current = 0; current < 100; current += 1) {
      for (let candidate = 0; candidate < 100; candidate += 1) {
        expect(isGarbageStoreEpoch(current, candidate)).toBe(candidate <= current - 2);
      }
    }
  });

  it('does not retain the deleted reset authority and resume mechanisms', () => {
    expect(storeSources().map((path) => path.split('/').at(-1))).not.toEqual(
      expect.arrayContaining([
        'backend-store-reset.ts',
        'reset-active-evidence.ts',
        'reset-retention.ts',
        'settlement-authority.ts',
      ]),
    );
    const all = storeSources().map(source).join('\n');
    expect(all).not.toMatch(/WriterExclusion|store_reset_lock_contended|store_reset_interrupted_/u);
  });
});
