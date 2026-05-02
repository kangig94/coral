import { describe, expect, it } from 'vitest';

import type { EnvPort } from '#src/infra/port-types.js';
import {
  CORAL_CURATE_CLAIM_STALE_MS_ENV,
  CORAL_CURATE_MAX_RETRY_MS_ENV,
  CORAL_CURATE_MISSING_CLI_RETRY_MS_ENV,
  CORAL_CURATE_TRANSIENT_RETRY_MS_ENV,
  DEFAULT_CLAIM_STALE_MS,
  DEFAULT_CURATE_MAX_RETRY_MS,
  DEFAULT_CURATE_MISSING_CLI_RETRY_MS,
  DEFAULT_CURATE_TRANSIENT_RETRY_MS,
  resolveCurateTimings,
} from '#src/kb/curate/state/index.js';

function envOf(values: Record<string, string | undefined>): Pick<EnvPort, 'get'> {
  return { get: (key) => values[key] };
}

describe('resolveCurateTimings', () => {
  it('returns documented defaults when no env vars are set', () => {
    const timings = resolveCurateTimings(envOf({}));
    expect(timings).toEqual({
      claimStaleMs: DEFAULT_CLAIM_STALE_MS,
      transientRetryMs: DEFAULT_CURATE_TRANSIENT_RETRY_MS,
      missingCliRetryMs: DEFAULT_CURATE_MISSING_CLI_RETRY_MS,
      maxRetryMs: DEFAULT_CURATE_MAX_RETRY_MS,
    });
    expect(DEFAULT_CLAIM_STALE_MS).toBe(15 * 60 * 1000);
    expect(DEFAULT_CURATE_TRANSIENT_RETRY_MS).toBe(30 * 60 * 1000);
    expect(DEFAULT_CURATE_MISSING_CLI_RETRY_MS).toBe(2 * 60 * 60 * 1000);
    expect(DEFAULT_CURATE_MAX_RETRY_MS).toBe(4 * 60 * 60 * 1000);
  });

  it('honours each env override independently when set to a positive integer', () => {
    const timings = resolveCurateTimings(
      envOf({
        [CORAL_CURATE_CLAIM_STALE_MS_ENV]: '60000',
        [CORAL_CURATE_TRANSIENT_RETRY_MS_ENV]: '120000',
        [CORAL_CURATE_MISSING_CLI_RETRY_MS_ENV]: '180000',
        [CORAL_CURATE_MAX_RETRY_MS_ENV]: '240000',
      }),
    );
    expect(timings).toEqual({
      claimStaleMs: 60_000,
      transientRetryMs: 120_000,
      missingCliRetryMs: 180_000,
      maxRetryMs: 240_000,
    });
  });

  it('falls back to defaults for blank, non-numeric, zero, and negative values', () => {
    const cases = ['', '   ', 'not-a-number', '0', '-1'];
    for (const value of cases) {
      const timings = resolveCurateTimings(
        envOf({
          [CORAL_CURATE_CLAIM_STALE_MS_ENV]: value,
          [CORAL_CURATE_TRANSIENT_RETRY_MS_ENV]: value,
          [CORAL_CURATE_MISSING_CLI_RETRY_MS_ENV]: value,
          [CORAL_CURATE_MAX_RETRY_MS_ENV]: value,
        }),
      );
      expect(timings).toEqual({
        claimStaleMs: DEFAULT_CLAIM_STALE_MS,
        transientRetryMs: DEFAULT_CURATE_TRANSIENT_RETRY_MS,
        missingCliRetryMs: DEFAULT_CURATE_MISSING_CLI_RETRY_MS,
        maxRetryMs: DEFAULT_CURATE_MAX_RETRY_MS,
      });
    }
  });
});
