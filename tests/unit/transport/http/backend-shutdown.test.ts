import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendInfo } from '#src/infra/backend-discovery.js';
import { observeCoordinator } from '#src/transport/http/backend/coordinator-observation.js';
import type { CoordinatorObservation } from '#src/transport/http/backend/coordinator-observation.js';

const mockState = vi.hoisted(() => ({
  observed: { kind: 'no-record' } as CoordinatorObservation,
  env: {} as Record<string, string>,
}));

// Mocked at the seam this function actually depends on. It used to mock `backend-discovery` and
// `node-process` separately and re-assemble the prelude they feed, which is two fixtures for one observation —
// the same duplication the production split removed.
vi.mock('#src/transport/http/backend/coordinator-observation.js', () => ({
  observeCoordinator: vi.fn(() => mockState.observed),
}));

vi.mock('#src/infra/bundle-manifest.js', () => ({
  readBuildFlavor: vi.fn(() => 'prod'),
}));

vi.mock('#src/runtime/real.js', () => ({
  createRealRuntime: vi.fn(() => ({
    storage: {},
    env: { fullSnapshot: () => ({ ...mockState.env }) },
    paths: { coral: { coordinator: { infoFile: '/run/coral/coordinator.json' } } },
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
    mockState.observed = { kind: 'addressed', coordinator: backendInfo() };
    mockState.env = {};
    vi.mocked(observeCoordinator).mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ status: 'draining', instanceId: 'test-instance' }), { status: 200 }),
      ),
    );
  });

  // `vi.stubGlobal` replaces a process-wide binding, so cleanup cannot live at the tail of each test: an
  // assertion that throws skips it, and a test that stubs without a tail call leaks its `fetch` into whatever
  // runs next. Three of the stubs here did exactly that until a reviewer reproduced the resulting flake. This
  // is the pattern `tests/unit/infra/http-retry.test.ts` already uses.
  afterEach(() => {
    vi.unstubAllGlobals();
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
      reason: 'nested_child',
    });

    expect(observeCoordinator, 'a nested child must refuse before it reads anything').not.toHaveBeenCalled();
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
    mockState.observed = { kind: 'addressed', coordinator: backendInfo({ shutdownToken: undefined }) };
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
  it.each([['corrupt-json'], ['shape-rejected']] as const)(
    'refuses to report not_running when the discovery record is %s',
    async (reason) => {
      mockState.observed = { kind: 'unreadable-record', reason, path: '/run/coral/coordinator.json' };
      // The record-derived view is still available, so a consumer reading only that would proceed as normal —
      // which is exactly the collapse this branch exists to stop.

      const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

      await expect(shutdownBackend('/plugin-root')).resolves.toEqual({
        ok: false,
        reason: 'unreadable_record',
        detail: reason,
      });
    },
  );

  // Found by sweeping for the pattern rather than by review: the same collapse sat one function below the
  // record split, where every way a request can fail to complete answered `not_running`.
  it('does not report not_running when the shutdown request never completed', async () => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo() };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
      }),
    );

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({
      ok: false,
      reason: 'unreachable',
      detail: 'ETIMEDOUT',
    });
  });

  it('reports not_running when the socket refused the connection', async () => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo() };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
      }),
    );

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({ ok: false, reason: 'socket_refused' });
  });

  // Each of these used to answer `not_running`, and the sentence rendered for that named a dial only the last
  // one performs. Split so the reason carries which observation was actually made.
  it('names an absent record as such, not as a refused socket', async () => {
    mockState.observed = { kind: 'no-record' };

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({ ok: false, reason: 'no_record' });
  });

  it('names a decisively gone recorded process as such', async () => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo() };
    mockState.observed = { kind: 'process-absent', pid: 12345 };

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({
      ok: false,
      reason: 'recorded_process_absent',
      detail: '12345',
    });
  });

  // `readBackendInfo` also returns null when `version`/`instanceId` are absent — fields the shutdown request
  // never reads — which is why `observeCoordinator` hands back the decoded record instead. A coordinator old
  // enough to omit them used to be reported as not running and never asked to stop.
  it('asks a pre-version incumbent to stop instead of calling it not running', async () => {
    const { version: _v, instanceId: _i, ...preVersion } = backendInfo();
    mockState.observed = { kind: 'addressed', coordinator: preVersion };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'draining' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({ ok: true });
    expect(
      fetchMock,
      'the request needs host, port and bootToken, all of which that record carries',
    ).toHaveBeenCalled();
  });
});
