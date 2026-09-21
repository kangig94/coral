import { describe, expect, it } from 'vitest';

import { shutdownModeFromReason } from '#src/coordinator/shutdown.js';
import { SHUTDOWN_REASONS, type ShutdownReason } from '#src/infra/persisted-scalar-contracts.js';

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
