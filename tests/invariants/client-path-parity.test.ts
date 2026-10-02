import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createRealRuntime } from '#src/runtime/real.js';
import { resolveCurrentStoreEpoch } from '#src/store/epoch/index.js';

describe('current store epoch selection', () => {
  it('selects a valid published epoch below an invalid newer epoch', () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'coral-client-epoch-'));
    try {
      const published = join(dbDir, 'epoch-1');
      mkdirSync(published);
      writeFileSync(join(published, '.lock'), '');
      writeFileSync(join(published, 'store.db'), 'published');
      writeFileSync(
        join(published, 'epoch.json'),
        JSON.stringify({
          supersedes: null,
          classification: { kind: 'unavailable' },
          build: {
            version: '0.10.9',
            buildSetId: 'build-set',
            bundleHash: 'bundle-hash',
            flavor: 'prod',
            storeFormatFingerprint: 'store-format',
          },
          publishedAt: '2026-09-15T00:00:00.000Z',
        }),
      );
      symlinkSync('.', join(dbDir, 'epoch-2'));

      expect(resolveCurrentStoreEpoch(createRealRuntime('prod').storage, dbDir)).toBe('1');
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it('refuses a store root whose symlink target vanished', () => {
    const parent = mkdtempSync(join(tmpdir(), 'coral-client-epoch-vanished-'));
    const dbDir = join(parent, 'store');
    symlinkSync(join(parent, 'vanished-target'), dbDir, 'dir');
    try {
      expect(() => resolveCurrentStoreEpoch(createRealRuntime('prod').storage, dbDir)).toThrowError(
        expect.objectContaining({ code: 'ENOENT' }),
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
