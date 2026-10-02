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
    mockState.observed = { kind: 'addressed', coordinator: backendInfo(), pidLiveness: 'alive' };
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
  // runs next.
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
  it('refuses to report not_running when the discovery record is unreadable', async () => {
    mockState.observed = { kind: 'unreadable-record', reason: 'shape-rejected', path: '/run/coral/coordinator.json' };
    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({
      ok: false,
      reason: 'unreadable_record',
      detail: 'shape-rejected',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  // The same collapse sat one function below the record split, where every way a request can fail to complete
  // answered `not_running`.
  it('does not report not_running when the shutdown request never completed', async () => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo(), pidLiveness: 'alive' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
      }),
    );

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({
      ok: false,
      reason: 'no_response',
      detail: 'ETIMEDOUT',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:4321/admin/shutdown',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  // A refused connection used to be reported as `not_running` here. It cannot be: an absent pid is excluded
  // before this request is ever sent (`case 'process-absent'` returns earlier), so `pidLiveness` is always
  // `'alive'` or `'unknown'` by this point — and `'alive'`, pinned by this fixture, is the deterministic window
  // where a coordinator's HTTP listener has closed at the top of its drain while its process, confirmed alive
  // moments earlier, keeps running through IPC close and the store finalizers. Reporting "not running" (and
  // exiting `1`, the "you may proceed" family per docs/cli-errors.md) there is the exact inversion this
  // fixture now guards against; `pidLiveness` is carried through so the render layer can say what was actually
  // known instead of promising an absence nothing here observed.
  it('reports socket_refused carrying pidLiveness, not a claimed absence', async () => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo(), pidLiveness: 'alive' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
      }),
    );

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({
      ok: false,
      reason: 'socket_refused',
      pidLiveness: 'alive',
      pid: 12345,
      recordPath: '/run/coral/coordinator.json',
    });
  });

  // Each of these used to answer `not_running`, and the sentence rendered for that named a dial only the last
  // one performs. Split so the reason carries which observation was actually made.
  it('names an absent record as such, not as a refused socket', async () => {
    mockState.observed = { kind: 'no-record' };

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({ ok: false, reason: 'no_record' });
  });

  it('refuses as no_record_socket_present rather than a confirmed absence when the coordinator socket exists', async () => {
    mockState.observed = { kind: 'no-record-socket-present', socketPath: '/tmp/coral.sock' };

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({
      ok: false,
      reason: 'no_record_socket_present',
    });
    expect(fetch, 'no host/port/bootToken exist to dial without a decoded record').not.toHaveBeenCalled();
  });

  it('names the process from the discovery record as decisively gone', async () => {
    mockState.observed = { kind: 'process-absent', pid: 12345, startedAt: 1 };

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({
      ok: false,
      reason: 'recorded_process_absent',
      detail: '12345',
    });
  });

  // The 401 branch had no test on this side at all. `formatShutdown` asserts the rendered sentence against a
  // hand-built result, so the pid could be dropped here and every test would stay green — a fixture agreeing
  // with a producer it never runs. The pid is the whole remedy in that message: the coordinator is alive and
  // will not accept our token, so identifying the process is the only action left.
  it('names the live coordinator when it rejects the boot token', async () => {
    mockState.observed = {
      kind: 'addressed',
      coordinator: backendInfo({ pid: 9001 }),
      pidLiveness: 'alive',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 401 })),
    );

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({
      ok: false,
      reason: 'capability_rejected',
      detail: '9001',
      pidLiveness: 'alive',
    });
  });

  // `parseJsonResponse` never throws for a resolved response, so this branch was reachable only through the
  // exception path's neighbor — a real HTTP response that resolved, was not a drain, and was not a 401. Only
  // the exception path had a test before this. `refused_by_response`, not `no_response`: a response arrived,
  // which is the one thing that proves something is listening — the same split `status.ts` makes with
  // `responded`.
  it('reports refused_by_response for a resolved response that is neither a drain nor a 401', async () => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo(), pidLiveness: 'alive' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' })),
    );

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({
      ok: false,
      reason: 'refused_by_response',
      detail: '500 Internal Server Error',
    });
  });
});
