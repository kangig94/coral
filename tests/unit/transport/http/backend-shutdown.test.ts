import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendInfo } from '#src/infra/backend-discovery.js';
import { readBackendInfo } from '#src/infra/backend-discovery.js';

const mockState = vi.hoisted(() => ({
  info: null as BackendInfo | null,
  env: {} as Record<string, string>,
}));

vi.mock('#src/infra/backend-discovery.js', () => ({
  readBackendInfo: vi.fn(() => mockState.info),
}));

vi.mock('#src/infra/bundle-manifest.js', () => ({
  readBuildFlavor: vi.fn(() => 'prod'),
}));

vi.mock('#src/infra/node-process.js', () => ({
  observeProcessLiveness: vi.fn(() => true),
}));

vi.mock('#src/runtime/real.js', () => ({
  createRealRuntime: vi.fn(() => ({
    storage: {},
    env: { fullSnapshot: () => ({ ...mockState.env }) },
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
    bootToken: 'boot-token',
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
    mockState.env = {};
    vi.mocked(readBackendInfo).mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ status: 'draining', instanceId: 'test-instance' }), { status: 200 }),
      ),
    );
  });

  it('rejects child lifecycle mutation before reading discovery or issuing HTTP', async () => {
    mockState.env = {
      CORAL_CHILD: '1',
      CORAL_CHILD_PRINCIPAL_HANDLE: 'child-handle',
      CORAL_JOB_ID: 'parent-job',
      CORAL_SESSION_ID: 'parent-session',
    };
    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({
      ok: false,
      reason:
        "this nested Coral process cannot shut down its parent coordinator; return to the top-level Coral session and run 'coral-cli backend shutdown' there",
    });

    expect(readBackendInfo).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the boot token for shutdown authorization', async () => {
    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({ ok: true });

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4321/admin/shutdown',
      expect.objectContaining({
        method: 'POST',
        headers: { 'X-Coral-Boot-Token': 'boot-token' },
      }),
    );
  });

  it('does not fall back to the backend token when the retired shutdown token is absent', async () => {
    mockState.info = backendInfo({ shutdownToken: undefined });
    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({ ok: true });

    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4321/admin/shutdown',
      expect.objectContaining({
        method: 'POST',
        headers: { 'X-Coral-Boot-Token': 'boot-token' },
      }),
    );
  });

  it('accepts retired 200 shutting_down responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'shutting_down' }), { status: 200 })),
    );
    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({ ok: true });
  });

  it('treats backend_shutting_down as already draining', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 'backend_shutting_down', message: 'Backend shutting down' }), {
            status: 503,
          }),
      ),
    );
    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({ ok: true, alreadyDraining: true });
  });
});
