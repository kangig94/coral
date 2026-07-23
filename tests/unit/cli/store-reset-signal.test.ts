import { describe, expect, it } from 'vitest';

import { isStoreResetReportInvocation } from '#src/cli/store-reset-signal.js';

describe('store-reset signal ownership', () => {
  it('owns signals only for the local report command', () => {
    expect(isStoreResetReportInvocation(['backend', 'store-reset', 'report', '123'])).toBe(true);
    expect(isStoreResetReportInvocation(['backend', 'store-reset', 'list'])).toBe(false);
    expect(isStoreResetReportInvocation(['wait', '--jobs', 'job-1'])).toBe(false);
    expect(isStoreResetReportInvocation(['codex', '-i', 'review'])).toBe(false);
  });
});
