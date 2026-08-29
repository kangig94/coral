import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '#src/store/db.js';
import { classifyTestDatabaseLocation } from '#tools/testing/store-db-location.js';

const TEMP_ROOT = resolve('test-temp-root');

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

  it('refuses an unrecognized tier explicitly', () => {
    expect(classifyTestDatabaseLocation(undefined, TEMP_ROOT, null)).toEqual({ kind: 'unrecognized-tier' });
    expect(classifyTestDatabaseLocation('other', TEMP_ROOT, null)).toEqual({ kind: 'unrecognized-tier' });
  });

  it('snapshots the environment on first assertion and freezes it', async () => {
    const previousTier = process.env.CORAL_TEST_TIER;
    delete process.env.CORAL_TEST_TIER;
    vi.resetModules();

    try {
      const policy = await import('#tools/testing/store-db-location.js');
      process.env.CORAL_TEST_TIER = 'unit';
      const memory = {
        location: () => null,
        close: vi.fn(),
      } as unknown as Database;

      expect(() => policy.assertTestDatabaseLocation(memory)).not.toThrow();

      process.env.CORAL_TEST_TIER = 'integration';
      const close = vi.fn();
      const file = {
        location: () => join(TEMP_ROOT, 'case', 'store.db'),
        close,
      } as unknown as Database;

      expect(() => policy.assertTestDatabaseLocation(file)).toThrow(/unit test database resolved to/u);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      if (previousTier === undefined) delete process.env.CORAL_TEST_TIER;
      else process.env.CORAL_TEST_TIER = previousTier;
      vi.resetModules();
    }
  });
});
