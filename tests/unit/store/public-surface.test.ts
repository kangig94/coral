import { describe, it, expect } from 'vitest';

import * as storeBarrel from '#src/store/index.js';

const ALLOWED_VALUE_EXPORTS = new Set([
  'openStoreDatabase',
  'applyStoreSchemas',
  'journalEventEnvelopeSchema',
]);

describe('src/store public surface', () => {
  // Note: Object.keys only enumerates value exports; `export type` entries are erased at runtime.
  // A drift-guard on *type* exports would require an AST walker; the allow-list is a value-only invariant.
  it('exports exactly the allow-listed value names (no more, no less)', () => {
    const actual = new Set(Object.keys(storeBarrel));
    const unexpected = [...actual].filter((k) => !ALLOWED_VALUE_EXPORTS.has(k));
    const missing = [...ALLOWED_VALUE_EXPORTS].filter((k) => !actual.has(k));
    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
    expect(actual.size).toBe(ALLOWED_VALUE_EXPORTS.size);
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
