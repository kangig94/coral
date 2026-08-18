import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'node:net';
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
    mockState.observed = {
      kind: 'addressed',
      coordinator: backendInfo({ shutdownToken: undefined }),
      pidLiveness: 'alive',
    };
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
    });
  });

  // The other half of `pidLiveness` on `socket_refused`: a prior liveness check that could not resolve either
  // way must not be upgraded to `'alive'` just because this test also drives a real closed socket below — this
  // one pins that `'unknown'` survives unchanged through the refused-connection path too.
  it('carries an unresolved pid liveness through a refused connection rather than upgrading it', async () => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo(), pidLiveness: 'unknown' };
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
      pidLiveness: 'unknown',
    });
  });

  // Each of these used to answer `not_running`, and the sentence rendered for that named a dial only the last
  // one performs. Split so the reason carries which observation was actually made.
  it('names an absent record as such, not as a refused socket', async () => {
    mockState.observed = { kind: 'no-record' };

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({ ok: false, reason: 'no_record' });
  });

  // A missing record alone used to refuse as `no_record` (exit 1, a confirmed absence) unconditionally —
  // including for a coordinator caught between binding its IPC socket and publishing this discovery record
  // (`observeCoordinator`'s `no-record-socket-present`). That window must refuse as not-observed instead.
  it('refuses as no_record_socket_present rather than a confirmed absence when the coordinator socket exists', async () => {
    mockState.observed = { kind: 'no-record-socket-present', socketPath: '/tmp/coral.sock' };

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({
      ok: false,
      reason: 'no_record_socket_present',
    });
    expect(fetch, 'no host/port/bootToken exist to dial without a decoded record').not.toHaveBeenCalled();
  });

  it('names a decisively gone recorded process as such', async () => {
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

  // The 401 proves a coordinator answers at the address; it proves nothing new about a pid `observeCoordinator`
  // could only mark `unknown`. Dropping `pidLiveness` here would silently promote that prior "unknown" to
  // "alive" the moment any response arrives, which is the exact §11 collapse this field exists to stop.
  it('carries an unresolved pid liveness through the 401 rather than upgrading it', async () => {
    mockState.observed = {
      kind: 'addressed',
      coordinator: backendInfo({ pid: 9001 }),
      pidLiveness: 'unknown',
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
      pidLiveness: 'unknown',
    });
  });

  // `readBackendInfo` also returns null when `version`/`instanceId` are absent — fields the shutdown request
  // never reads — which is why `observeCoordinator` hands back the decoded record instead. A coordinator old
  // enough to omit them used to be reported as not running and never asked to stop.
  it('asks a pre-version incumbent to stop instead of calling it not running', async () => {
    const { version: _v, instanceId: _i, ...preVersion } = backendInfo();
    mockState.observed = { kind: 'addressed', coordinator: preVersion, pidLiveness: 'alive' };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'draining' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({ ok: true });
    expect(
      fetchMock,
      'the request needs host, port and bootToken, all of which that record carries',
    ).toHaveBeenCalled();
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

  // Neither the error nor its `.cause` carries a `.code` at all, so `thrownErrnoCode` must fall all the way
  // through to the error's own message rather than stringifying `undefined` or throwing.
  it('falls back to the error message when nothing carries an errno code', async () => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo(), pidLiveness: 'alive' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom');
      }),
    );

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({
      ok: false,
      reason: 'no_response',
      detail: 'boom',
    });
  });

  // Method requirement: a hand-built `Error` that happens to carry the shape the reader expects is exactly how
  // `socket_refused` went dead in the first place (`code: 'ECONNREFUSED'` set at the top level, which real
  // `fetch` never does — see the measurement note on `thrownErrnoCode` in `src/infra/error-format.ts`). These two drive the real
  // global `fetch` against a real socket instead of a fixture, so the assertion cannot agree with the bug.
  it('reports socket_refused against a real closed port, not a hand-built error', async () => {
    const { createServer } = await import('node:net');
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const address = probe.address();
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
    const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    // `close()`'s callback fires once the JS handle is released, which measurably races ahead of this host's
    // own kernel-level socket teardown: connecting immediately after intermittently still reaches the old
    // listener (or gets `ECONNRESET` off a not-yet-torn-down socket) instead of the `ECONNREFUSED` a port with
    // nothing on it produces. One macrotask turn is enough for the teardown to land before the real dial below.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    // Nothing listens on `port` from here on.

    vi.unstubAllGlobals();
    mockState.observed = {
      kind: 'addressed',
      coordinator: backendInfo({ host: '127.0.0.1', port }),
      pidLiveness: 'alive',
    };

    const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');

    await expect(shutdownBackend('/plugin-root')).resolves.toEqual({
      ok: false,
      reason: 'socket_refused',
      pidLiveness: 'alive',
    });
  });

  it('reports no_response with a string detail, not a numeric DOMException code, against a real timeout', async () => {
    const { createServer } = await import('node:net');
    // `net.Server#close` waits for every accepted connection to end before its callback fires — unlike
    // `http.Server`, it has no `closeAllConnections()`. The client aborts on its own timeout, but nothing here
    // ever ends the *server*-side socket, so without tracking and destroying it by hand `server.close()` would
    // hang past this test's own timeout (measured: it does, reproducibly).
    const sockets: Socket[] = [];
    const server = createServer((socket) => {
      // Accept the connection and never respond, so the client's own AbortSignal.timeout is what fires.
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a TCP address');

    vi.unstubAllGlobals();
    mockState.observed = {
      kind: 'addressed',
      coordinator: backendInfo({ host: '127.0.0.1', port: address.port }),
      pidLiveness: 'alive',
    };

    try {
      const { shutdownBackend } = await import('#src/transport/http/backend/shutdown.js');
      const result = await shutdownBackend('/plugin-root');

      expect(result.ok).toBe(false);
      if (result.ok || result.reason !== 'no_response') throw new Error('expected a no_response result');
      // Measured on Node v26.3.1: a `fetch` timeout rejects with a `DOMException` whose own `.code` is the
      // number `23`, not an errno. `detail` must never carry that raw number to an operator.
      expect(typeof result.detail).toBe('string');
      expect(result.detail).not.toBe('23');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);
});
