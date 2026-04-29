import { describe, expect, it } from 'vitest';

import type { EnvPort } from '#src/runtime/ports.js';
import {
  CORAL_WORKFLOW_DRAIN_TIMEOUT_MS_ENV,
  DEFAULT_DRAIN_DEADLINE_MS,
  resolveDrainDeadlineMs,
} from '#src/workflow/execution-constants.js';

// M1: workflow drain deadline must be configurable. The hardcoded 15s did not
// give long-running siblings of a failing slot enough time to abort gracefully.

function envOf(value: string | undefined): Pick<EnvPort, 'get'> {
  return {
    get: (key) => (key === CORAL_WORKFLOW_DRAIN_TIMEOUT_MS_ENV ? value : undefined),
  };
}

describe('resolveDrainDeadlineMs (M1)', () => {
  it('uses DEFAULT_DRAIN_DEADLINE_MS when the env var is unset', () => {
    expect(resolveDrainDeadlineMs(envOf(undefined))).toBe(DEFAULT_DRAIN_DEADLINE_MS);
    expect(DEFAULT_DRAIN_DEADLINE_MS).toBe(15_000);
  });

  it('uses the override when CORAL_WORKFLOW_DRAIN_TIMEOUT_MS is a positive integer', () => {
    expect(resolveDrainDeadlineMs(envOf('60000'))).toBe(60_000);
  });

  it('falls back to the default for blank, non-numeric, zero, and negative values', () => {
    expect(resolveDrainDeadlineMs(envOf(''))).toBe(DEFAULT_DRAIN_DEADLINE_MS);
    expect(resolveDrainDeadlineMs(envOf('   '))).toBe(DEFAULT_DRAIN_DEADLINE_MS);
    expect(resolveDrainDeadlineMs(envOf('not-a-number'))).toBe(DEFAULT_DRAIN_DEADLINE_MS);
    expect(resolveDrainDeadlineMs(envOf('0'))).toBe(DEFAULT_DRAIN_DEADLINE_MS);
    expect(resolveDrainDeadlineMs(envOf('-5'))).toBe(DEFAULT_DRAIN_DEADLINE_MS);
  });
});
