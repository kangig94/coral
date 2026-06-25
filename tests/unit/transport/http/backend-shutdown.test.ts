import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendInfo } from '#src/infra/backend-discovery.js';

const mockState = vi.hoisted(() => ({
  info: null as BackendInfo | null,
}));

vi.mock('#src/infra/backend-discovery.js', () => ({
  readBackendInfo: vi.fn(() => mockState.info),
}));

vi.mock('#src/infra/bundle-manifest.js', () => ({
  readBuildFlavor: vi.fn(() => 'prod'),
}));

vi.mock('#src/infra/node-process.js', () => ({
  isProcessAlive: vi.fn(() => true),
}));

vi.mock('#src/runtime/real.js', () => ({
  createRealRuntime: vi.fn(() => ({
    storage: {},
    env: {},
    paths: {},
  })),
}));

function backendInfo(overrides: Partial<BackendInfo> = {}): BackendInfo {
  return {
    pid: 12345,
    port: 4321,
    host: '127.0.0.1',
    socketPath: '/tmp/coral.sock',
    token: 'backend-token',
    shutdownToken: 'shutdown-token',
    version: '0.0.0',
    bundleHash: 'bundle-hash',
    flavor: 'prod',
    namespace: 'test-namespace',
    instanceId: 'test-instance',
    startedAt: 1,
    ...overrides,
  };
}

describe('shutdownBackend', () => {
  beforeEach(() => {
    mockState.info = backendInfo();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'shutting_down' }), { status: 200 })),
    );
  });

  it('uses the dedicated shutdown token when discovery provides one', async () => {
    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({ ok: true });

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4321/admin/shutdown',
      expect.objectContaining({
        method: 'POST',
        headers: { 'X-Coral-Shutdown-Token': 'shutdown-token' },
      }),
    );
  });

  it('falls back to the backend token for legacy discovery records', async () => {
    mockState.info = backendInfo({ shutdownToken: undefined });
    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({ ok: true });

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4321/admin/shutdown',
      expect.objectContaining({
        method: 'POST',
        headers: { 'X-Coral-Backend-Token': 'backend-token' },
      }),
    );
  });
});
