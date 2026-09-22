import { describe, expect, it } from 'vitest';

import { shutdownModeFromReason, SHUTDOWN_REASONS, type ShutdownReason } from '#src/infra/shutdown-contract.js';

describe('shutdownModeFromReason', () => {
  const expectedModes: Readonly<Record<ShutdownReason, 'handoff' | 'hard'>> = {
    replaced: 'handoff',
    sigterm: 'handoff',
    'provider-proxy-lifecycle-fatal': 'handoff',
    sigint: 'hard',
    idle: 'hard',
    'test-teardown': 'hard',
  };

  it.each(SHUTDOWN_REASONS)('maps %s to its assigned mode', (reason) => {
    expect(shutdownModeFromReason(reason)).toBe(expectedModes[reason]);
  });
});
