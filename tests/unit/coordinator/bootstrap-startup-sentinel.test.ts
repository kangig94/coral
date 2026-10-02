import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createCoordinatorServer: vi.fn(),
  writeBootstrapDiagnostic: vi.fn(() => '/state/startup-diagnostic.json'),
  writeStartupErrorSentinel: vi.fn(),
  auditBootstrapFailure: vi.fn(),
}));

vi.mock('#src/coordinator/index.js', () => ({ createCoordinatorServer: mocks.createCoordinatorServer }));
vi.mock('#src/coordinator/bootstrap-diagnostics.js', () => ({
  writeBootstrapDiagnostic: mocks.writeBootstrapDiagnostic,
  writeStartupErrorSentinel: mocks.writeStartupErrorSentinel,
  auditBootstrapFailure: mocks.auditBootstrapFailure,
}));

import { main } from '#src/coordinator/bootstrap.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('backend startup sentinel', () => {
  it('writes the sentinel when synchronous coordinator composition fails', async () => {
    const error = new Error(
      'CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS must be at least 36001ms to satisfy the timing policy',
    );
    mocks.createCoordinatorServer.mockImplementation(() => {
      throw error;
    });

    await expect(main()).resolves.toBe(1);

    expect(mocks.writeStartupErrorSentinel).toHaveBeenCalledWith(
      expect.any(String),
      error,
      '/state/startup-diagnostic.json',
    );
  });
});
