import { describe, expect, it } from 'vitest';

import type { EnvPort } from '#src/infra/port-types.js';
import {
  CORAL_KB_CURATE_CLAIM_STALE_MS_ENV,
  CORAL_KB_CURATE_MAX_RETRY_MS_ENV,
  CORAL_KB_CURATE_MISSING_CLI_RETRY_MS_ENV,
  CORAL_KB_CURATE_TRANSIENT_RETRY_MS_ENV,
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
  it('falls back to defaults for blank, non-numeric, zero, and negative values', () => {
    const cases = ['', '   ', 'not-a-number', '0', '-1'];
    for (const value of cases) {
      const timings = resolveCurateTimings(
        envOf({
          [CORAL_KB_CURATE_CLAIM_STALE_MS_ENV]: value,
          [CORAL_KB_CURATE_TRANSIENT_RETRY_MS_ENV]: value,
          [CORAL_KB_CURATE_MISSING_CLI_RETRY_MS_ENV]: value,
          [CORAL_KB_CURATE_MAX_RETRY_MS_ENV]: value,
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
