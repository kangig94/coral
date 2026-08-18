import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const livenessMock = vi.hoisted(() => vi.fn<() => 'alive' | 'absent' | 'unknown'>(() => 'alive'));
vi.mock('#src/infra/node-process.js', () => ({
  observeProcessLiveness: livenessMock,
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
  it.each([['corrupt-json'], ['shape-rejected']] as const)(
    'refuses to report not_running when the discovery record is %s',
    async (reason) => {
      mockState.read = { kind: 'undecodable', reason };
      // The record-derived view is still available, so a consumer reading only that would proceed as normal —
      // which is exactly the collapse this branch exists to stop.
      mockState.info = backendInfo();

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
    mockState.read = { kind: 'record', record: backendInfo() };
    mockState.info = backendInfo();
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
    mockState.read = { kind: 'record', record: backendInfo() };
    mockState.info = backendInfo();
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
    mockState.read = { kind: 'missing' };
    mockState.info = null;

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({ ok: false, reason: 'no_record' });
  });

  it('names a decisively gone recorded process as such', async () => {
    mockState.read = { kind: 'record', record: backendInfo() };
    mockState.info = backendInfo();
    livenessMock.mockReturnValue('absent');

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({
      ok: false,
      reason: 'recorded_process_absent',
      detail: '12345',
    });
    livenessMock.mockReturnValue('alive');
  });

  // `readBackendInfo` also returns null when `version`/`instanceId` are absent — fields the shutdown request
  // never reads. A coordinator old enough to omit them was therefore reported as not running and never asked
  // to stop, which is the cross-version case `.passthrough()` on the record schema exists for.
  it('asks a pre-version incumbent to stop instead of calling it not running', async () => {
    const { version: _v, instanceId: _i, ...preVersion } = backendInfo();
    mockState.read = { kind: 'record', record: preVersion };
    mockState.info = null;
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
