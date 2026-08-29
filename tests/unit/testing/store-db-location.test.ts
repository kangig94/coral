import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
});
