import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendInfo, DiscoveryRead } from '#src/infra/backend-discovery.js';
import { readBackendInfo } from '#src/infra/backend-discovery.js';

const mockState = vi.hoisted(() => ({
  info: null as BackendInfo | null,
  read: { kind: 'missing' } as DiscoveryRead,
  env: {} as Record<string, string>,
}));

vi.mock('#src/infra/backend-discovery.js', () => ({
  readBackendInfo: vi.fn(() => mockState.info),
  readDiscoveryRecordDisposition: vi.fn(() => mockState.read),
}));

vi.mock('#src/infra/bundle-manifest.js', () => ({
  readBuildFlavor: vi.fn(() => 'prod'),
}));

vi.mock('#src/infra/node-process.js', () => ({
  observeProcessLiveness: vi.fn(() => 'alive'),
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
    mockState.read = { kind: 'record', record: backendInfo() };
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

  // A file that exists and cannot be decoded is not an absent coordinator. Reporting `not_running` here would
  // skip a shutdown request a live daemon is waiting for, and the operator would then be told the thing they
  // are trying to stop is already stopped.
  it.each([
    ['corrupt-json', 'discovery_record_corrupt_json'],
    ['shape-rejected', 'discovery_record_shape_rejected'],
  ] as const)('refuses to report not_running when the discovery record is %s', async (reason, expected) => {
    mockState.read = { kind: 'undecodable', reason };
    // The record-derived view is still available, so a consumer reading only that would proceed as normal —
    // which is exactly the collapse this branch exists to stop.
    mockState.info = backendInfo();

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({ ok: false, reason: expected });
  });
});
