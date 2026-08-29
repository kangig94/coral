import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Database } from '#src/store/db.js';
import { classifyTestDatabaseLocation } from '#tools/testing/store-db-location.js';

const TEMP_ROOT = resolve('test-temp-root');
const scratchDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock('node:fs');
  vi.resetModules();
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('test database location', () => {
  it('accepts in-memory databases in every recognized tier', () => {
    expect(classifyTestDatabaseLocation('unit', TEMP_ROOT, null)).toEqual({ kind: 'allowed' });
    expect(classifyTestDatabaseLocation('simulation', TEMP_ROOT, null)).toEqual({ kind: 'allowed' });
    expect(classifyTestDatabaseLocation('integration', TEMP_ROOT, null)).toEqual({ kind: 'allowed' });
    expect(classifyTestDatabaseLocation('e2e', TEMP_ROOT, null)).toEqual({ kind: 'allowed' });
  });

  it('rejects files in unit and simulation tiers', () => {
    const location = join(TEMP_ROOT, 'case', 'store.db');

    expect(classifyTestDatabaseLocation('unit', TEMP_ROOT, location)).toEqual({
      kind: 'file-forbidden',
      tier: 'unit',
      location,
    });
    expect(classifyTestDatabaseLocation('simulation', TEMP_ROOT, location)).toEqual({
      kind: 'file-forbidden',
      tier: 'simulation',
      location,
    });
  });

  it('accepts integration and e2e files under the temp root', () => {
    const location = join(TEMP_ROOT, 'case', 'store.db');

    expect(classifyTestDatabaseLocation('integration', TEMP_ROOT, location)).toEqual({ kind: 'allowed' });
    expect(classifyTestDatabaseLocation('e2e', TEMP_ROOT, location)).toEqual({ kind: 'allowed' });
  });

  it('rejects a location equal to the temp root', () => {
    expect(classifyTestDatabaseLocation('integration', TEMP_ROOT, TEMP_ROOT)).toEqual({
      kind: 'outside-temp-root',
      tier: 'integration',
      location: TEMP_ROOT,
      tempRoot: TEMP_ROOT,
    });
  });

  it('resolves a relative location before checking the temp-root boundary', () => {
    const relativeLocation = join('test-temp-root', 'case', 'store.db');

    expect(classifyTestDatabaseLocation('integration', TEMP_ROOT, relativeLocation)).toEqual({ kind: 'allowed' });
  });

  it('rejects an empty-string location outside the temp root', () => {
    expect(classifyTestDatabaseLocation('integration', TEMP_ROOT, '')).toEqual({
      kind: 'outside-temp-root',
      tier: 'integration',
      location: resolve(''),
      tempRoot: TEMP_ROOT,
    });
  });

  it('rejects integration files outside the temp root', () => {
    const location = `${TEMP_ROOT}-outside/store.db`;

    expect(classifyTestDatabaseLocation('integration', TEMP_ROOT, location)).toEqual({
      kind: 'outside-temp-root',
      tier: 'integration',
      location,
      tempRoot: TEMP_ROOT,
    });
  });

  it('accepts a child whose name begins with two dots', () => {
    const location = join(TEMP_ROOT, '..cache', 'store.db');

    expect(classifyTestDatabaseLocation('integration', TEMP_ROOT, location)).toEqual({ kind: 'allowed' });
  });

  it('rejects an existing location whose in-root symlink resolves outside the temp root', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'coral-store-location-'));
    scratchDirectories.push(scratch);
    const tempRoot = join(scratch, 'temp');
    const outside = join(scratch, 'outside');
    mkdirSync(tempRoot);
    mkdirSync(outside);
    const outsideStore = join(outside, 'store.db');
    writeFileSync(outsideStore, '');
    symlinkSync(outside, join(tempRoot, 'linked'), 'dir');

    expect(classifyTestDatabaseLocation('integration', tempRoot, join(tempRoot, 'linked', 'store.db'))).toEqual({
      kind: 'outside-temp-root',
      tier: 'integration',
      location: realpathSync(outsideStore),
      tempRoot: realpathSync(tempRoot),
    });
  });

  it('refuses an unrecognized tier explicitly', () => {
    expect(classifyTestDatabaseLocation(undefined, TEMP_ROOT, null)).toEqual({ kind: 'unrecognized-tier' });
    expect(classifyTestDatabaseLocation('other', TEMP_ROOT, null)).toEqual({ kind: 'unrecognized-tier' });
  });

  it('closes the handle and preserves the cause when path resolution fails', async () => {
    const resolutionError = Object.assign(new Error('path changed during resolution'), { code: 'EACCES' });
    const location = join(TEMP_ROOT, 'case', 'store.db');
    let failingPath = TEMP_ROOT;
    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');
      return {
        ...actual,
        existsSync: () => true,
        realpathSync: (path: string) => {
          if (path === failingPath) throw resolutionError;
          return path;
        },
      };
    });
    vi.stubGlobal(Symbol.for('coral.testing.enforced-test-location-policy'), {
      tier: 'integration',
      tempRoot: TEMP_ROOT,
    });
    const policy = await import('#tools/testing/store-db-location.js');
    expect(policy.classifyTestDatabaseLocation('integration', TEMP_ROOT, location)).toEqual({
      kind: 'resolution-failed',
      tier: 'integration',
      location,
      tempRoot: TEMP_ROOT,
      path: TEMP_ROOT,
      cause: resolutionError,
    });

    failingPath = location;
    expect(policy.classifyTestDatabaseLocation('integration', TEMP_ROOT, location)).toEqual({
      kind: 'resolution-failed',
      tier: 'integration',
      location,
      tempRoot: TEMP_ROOT,
      path: location,
      cause: resolutionError,
    });
    const close = vi.fn();
    const db = {
      location: () => location,
      close,
    } as unknown as Database;

    let caught: unknown;
    try {
      policy.assertTestDatabaseLocation(db);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/could not be resolved safely/u);
    expect((caught as Error & { cause?: unknown }).cause).toBe(resolutionError);
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps the original e2e tier and temp root after a module reset', async () => {
    const policySymbol = Symbol.for('coral.testing.enforced-test-location-policy');
    const originalTempRoot = resolve('original-test-temp-root');
    const changedTempRoot = resolve('changed-test-temp-root');
    vi.stubGlobal(policySymbol, undefined);
    vi.stubEnv('CORAL_TEST_TIER', 'e2e');
    vi.stubEnv('TMPDIR', originalTempRoot);
    vi.resetModules();
    const policy = await import('#tools/testing/store-db-location.js');
    const outsideClose = vi.fn();
    const outside = {
      location: () => resolve('outside-test-temp-root', 'store.db'),
      close: outsideClose,
    } as unknown as Database;

    expect(() => policy.assertTestDatabaseLocation(outside)).toThrow(/e2e test database resolved to/u);
    expect(outsideClose).toHaveBeenCalledOnce();

    const originalClose = vi.fn();
    const originalLocation = {
      location: () => join(originalTempRoot, 'case', 'store.db'),
      close: originalClose,
    } as unknown as Database;
    expect(() => policy.assertTestDatabaseLocation(originalLocation)).not.toThrow();

    vi.resetModules();
    vi.stubEnv('CORAL_TEST_TIER', 'unit');
    vi.stubEnv('TMPDIR', changedTempRoot);
    const reloadedPolicy = await import('#tools/testing/store-db-location.js');
    expect(() => reloadedPolicy.assertTestDatabaseLocation(originalLocation)).not.toThrow();
    expect(originalClose).not.toHaveBeenCalled();
    const close = vi.fn();
    const changedLocation = {
      location: () => join(changedTempRoot, 'case', 'store.db'),
      close,
    } as unknown as Database;

    let changedLocationError: unknown;
    try {
      reloadedPolicy.assertTestDatabaseLocation(changedLocation);
    } catch (error: unknown) {
      changedLocationError = error;
    }
    expect(changedLocationError).toBeInstanceOf(Error);
    expect((changedLocationError as Error).message).toContain(
      `e2e test database resolved to ${join(changedTempRoot, 'case', 'store.db')}`,
    );
    expect((changedLocationError as Error).message).toContain(`test temp root ${originalTempRoot}`);
    expect(close).toHaveBeenCalledOnce();
  });
});
