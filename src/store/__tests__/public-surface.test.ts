import { describe, it, expect } from 'vitest';

import * as storeBarrel from '../index.js';

const ALLOWED_VALUE_EXPORTS = new Set([
  'CoralStore',
  'openStoreDatabase',
  'applyMigrations',
  'journalEventEnvelopeSchema',
]);

describe('src/store public surface (AC11)', () => {
  it('exports only the allow-listed value names', () => {
    const actual = new Set(Object.keys(storeBarrel));
    const unexpected = [...actual].filter((k) => !ALLOWED_VALUE_EXPORTS.has(k));
    expect(unexpected).toEqual([]);
    for (const expected of ALLOWED_VALUE_EXPORTS) {
      expect(actual.has(expected)).toBe(true);
    }
  });

  it('does NOT expose appendEvents', () => {
    expect((storeBarrel as Record<string, unknown>).appendEvents).toBeUndefined();
  });

  it('does NOT expose rebuildProjections', () => {
    expect((storeBarrel as Record<string, unknown>).rebuildProjections).toBeUndefined();
  });

  it('does NOT expose storePaths', () => {
    expect((storeBarrel as Record<string, unknown>).storePaths).toBeUndefined();
  });
});
