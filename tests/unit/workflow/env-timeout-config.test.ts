import { describe, expect, it } from 'vitest';

import type { EnvPort } from '#src/runtime/ports.js';
import {
  CORAL_WORKFLOW_DRAIN_TIMEOUT_MS_ENV,
  DEFAULT_DRAIN_DEADLINE_MS,
  resolveDrainDeadlineMs,
} from '#src/workflow/execution-constants.js';
import {
  CORAL_STALE_ABORT_TIMEOUT_MS_ENV,
  DEFAULT_STALE_ABORT_TIMEOUT_MS,
  resolveStaleAbortTimeoutMs,
} from '#src/workflow/stale-recovery.js';

function envOf(envVar: string, value: string | undefined): Pick<EnvPort, 'get'> {
  return { get: (key) => (key === envVar ? value : undefined) };
}

const cases = [
  {
    name: 'resolveDrainDeadlineMs (M1)',
    fn: resolveDrainDeadlineMs,
    envVar: CORAL_WORKFLOW_DRAIN_TIMEOUT_MS_ENV,
    defaultMs: DEFAULT_DRAIN_DEADLINE_MS,
    expectedDefault: 15_000,
  },
  {
    name: 'resolveStaleAbortTimeoutMs',
    fn: resolveStaleAbortTimeoutMs,
    envVar: CORAL_STALE_ABORT_TIMEOUT_MS_ENV,
    defaultMs: DEFAULT_STALE_ABORT_TIMEOUT_MS,
    expectedDefault: 30_000,
  },
];

describe.each(cases)('$name', ({ fn, envVar, defaultMs, expectedDefault }) => {
  it('uses the documented default when the env var is unset', () => {
    expect(fn(envOf(envVar, undefined))).toBe(defaultMs);
    expect(defaultMs).toBe(expectedDefault);
  });

  it('uses the override when the env var is a positive integer', () => {
    expect(fn(envOf(envVar, '60000'))).toBe(60_000);
  });

  it('falls back to the default for blank, non-numeric, zero, and negative values', () => {
    expect(fn(envOf(envVar, ''))).toBe(defaultMs);
    expect(fn(envOf(envVar, '   '))).toBe(defaultMs);
    expect(fn(envOf(envVar, 'not-a-number'))).toBe(defaultMs);
    expect(fn(envOf(envVar, '0'))).toBe(defaultMs);
    expect(fn(envOf(envVar, '-5'))).toBe(defaultMs);
  });
});

// resolveStaleAbortTimeoutMs has a unique floor that drain-deadline does not.
describe('resolveStaleAbortTimeoutMs additional behavior', () => {
  it('clamps positive values below 1s up to the 1s minimum', () => {
    expect(resolveStaleAbortTimeoutMs(envOf(CORAL_STALE_ABORT_TIMEOUT_MS_ENV, '500'))).toBe(1_000);
  });
});
