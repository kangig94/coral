// `getBackendStatusFull` has two independent ways to fail to reach an answer, and for a while both arrived as
// `not_running` — a status an operator reads as "nothing is there, start one".
//
// The process axis was split first: only an observed `'absent'` reports not-running. The record axis was
// missed, because both consumers reach it through `readBackendInfo`, whose `null` covers a missing file, an
// undecodable one, *and* a record lacking `version`/`instanceId`. So a `coordinator.json` truncated mid-write,
// or written by a build whose shape this one rejects, reported a confident absence while a coordinator was
// serving on the socket.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendInfo } from '#src/infra/backend-discovery.js';
import type { CoordinatorObservation } from '#src/transport/http/backend/coordinator-observation.js';

const mockState = vi.hoisted(() => ({
  observed: { kind: 'no-record' } as CoordinatorObservation,
}));

// Mocked at the seam this function depends on. `status` and `shutdown` ask the same three questions about the
// coordinator, and driving them through two lower mocks meant each test file re-assembled that prelude itself
// — two fixtures for one observation, which is the duplication the production split removed.
vi.mock('#src/transport/http/backend/coordinator-observation.js', () => ({
  observeCoordinator: vi.fn(() => mockState.observed),
}));

vi.mock('#src/infra/bundle-manifest.js', () => ({
  readBuildFlavor: vi.fn(() => 'prod'),
}));

vi.mock('#src/runtime/real.js', () => ({
  createRealRuntime: vi.fn(() => ({
    storage: {
      readFileSync: () => {
        throw Object.assign(new Error('no diagnostic'), { code: 'ENOENT' });
      },
    },
    env: {},
    time: { now: () => 1_700_000_000_000 },
    paths: {
      coral: {
        coordinator: { startupDiagnosticFile: '/tmp/coral-startup.json', infoFile: '/run/coral/coordinator.json' },
      },
    },
  })),
}));

function backendInfo(): BackendInfo {
  return {
    pid: 12345,
    port: 4321,
    host: '127.0.0.1',
    socketPath: '/tmp/coral.sock',
    token: 'backend-token',
    bootToken: 'boot-token',
    version: '0.0.0',
    bundleHash: 'bundle-hash',
    flavor: 'prod',
    namespace: 'test-namespace',
    instanceId: 'test-instance',
    startedAt: 1,
  };
}

describe('getBackendStatusFull record disposition', () => {
  beforeEach(() => {
    mockState.observed = { kind: 'no-record' };
  });

  // `vi.stubGlobal` replaces a process-wide binding, so cleanup cannot live at the tail of each test: an
  // assertion that throws skips it, and a test that stubs without a tail call leaks its `fetch` into whatever
  // runs next. Three of the stubs here did exactly that until a reviewer reproduced the resulting flake. This
  // is the pattern `tests/unit/infra/http-retry.test.ts` already uses.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports not_running when the record is genuinely missing', async () => {
    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({ status: 'not_running' });
  });

  // Same fields, same omission, same wrong answer as the shutdown path: `readBackendInfo` returns `null` when
  // `version` or `instanceId` is absent, and nothing here reads either — the version an operator sees is the
  // one in the health response.
  it('does not report a pre-version incumbent as not running', async () => {
    const { version: _v, instanceId: _i, ...preVersion } = backendInfo();
    mockState.observed = { kind: 'addressed', coordinator: preVersion };
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');
    const result = await getBackendStatusFull('/plugin-root');

    // What this change establishes: the daemon is asked at all. Before it, `readBackendInfo` answered `null`
    // for this record and the function short-circuited to a not-running report without dialling anything.
    expect(fetchMock, 'the record carries host, port and bootToken, so the daemon can be asked').toHaveBeenCalled();
    // And the answer is now `unreachable` rather than `not_running`: the 500 came from something listening at
    // the recorded address. An earlier revision of this test pinned `not_running` here and called the
    // difference out of scope; the sweep that enumerated the class reached it, so it is in scope after all.
    expect(result.status).toBe('unreachable');
  });

  // Six call sites answered "not running" for three different things. A peer identifying as another namespace
  // really is not this backend; a bad response and a dead request are not absence at all.
  it('reports a coordinator that answers badly as unreachable, not as stopped', async () => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo() };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({ status: 'unreachable' });
  });

  it('still reports not_running for a peer whose namespace says it is not this backend', async () => {
    mockState.observed = { kind: 'addressed', coordinator: backendInfo() };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: 'ok', namespace: 'someone-else', flavor: 'prod' }), { status: 200 }),
      ),
    );

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

    await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({ status: 'not_running' });
  });

  it.each([['corrupt-json'], ['shape-rejected']] as const)(
    'reports the %s record as its own status, not as an absent coordinator',
    async (reason) => {
      mockState.observed = { kind: 'unreadable-record', reason, path: '/run/coral/coordinator.json' };
      // The record-derived view is still populated here, so a consumer reading only that would fall through to
      // the liveness check and report `not_running` — the collapse this branch exists to stop.

      const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

      await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
        status: 'undecodable_record',
        reason,
        path: '/run/coral/coordinator.json',
      });
    },
  );
});
