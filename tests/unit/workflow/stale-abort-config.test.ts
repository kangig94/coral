import { describe, expect, it } from 'vitest';

import type { EnvPort } from '#src/runtime/ports.js';
import {
  CORAL_STALE_ABORT_TIMEOUT_MS_ENV,
  DEFAULT_STALE_ABORT_TIMEOUT_MS,
  resolveStaleAbortTimeoutMs,
} from '#src/workflow/stale-recovery.js';

function envOf(value: string | undefined): Pick<EnvPort, 'get'> {
  return {
    get: (key) => (key === CORAL_STALE_ABORT_TIMEOUT_MS_ENV ? value : undefined),
  };
}

describe('resolveStaleAbortTimeoutMs', () => {
  it('uses DEFAULT_STALE_ABORT_TIMEOUT_MS when the env var is unset', () => {
    expect(resolveStaleAbortTimeoutMs(envOf(undefined))).toBe(DEFAULT_STALE_ABORT_TIMEOUT_MS);
    expect(DEFAULT_STALE_ABORT_TIMEOUT_MS).toBe(30_000);
  });

  it('uses the override when CORAL_STALE_ABORT_TIMEOUT_MS is a positive integer', () => {
    expect(resolveStaleAbortTimeoutMs(envOf('60000'))).toBe(60_000);
  });

  it('falls back to the default for blank, non-numeric, zero, and negative values', () => {
    expect(resolveStaleAbortTimeoutMs(envOf(''))).toBe(DEFAULT_STALE_ABORT_TIMEOUT_MS);
    expect(resolveStaleAbortTimeoutMs(envOf('   '))).toBe(DEFAULT_STALE_ABORT_TIMEOUT_MS);
    expect(resolveStaleAbortTimeoutMs(envOf('not-a-number'))).toBe(DEFAULT_STALE_ABORT_TIMEOUT_MS);
    expect(resolveStaleAbortTimeoutMs(envOf('0'))).toBe(DEFAULT_STALE_ABORT_TIMEOUT_MS);
    expect(resolveStaleAbortTimeoutMs(envOf('-5'))).toBe(DEFAULT_STALE_ABORT_TIMEOUT_MS);
  });

  it('clamps positive values below 1s up to the 1s minimum', () => {
    expect(resolveStaleAbortTimeoutMs(envOf('500'))).toBe(1_000);
  });
});
