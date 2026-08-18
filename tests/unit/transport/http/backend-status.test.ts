// `getBackendStatusFull` has two independent ways to fail to reach an answer, and for a while both arrived as
// `not_running` — a status an operator reads as "nothing is there, start one".
//
// The process axis was split first: only an observed `'absent'` reports not-running. The record axis was
// missed, because both consumers reach it through `readBackendInfo`, whose `null` covers a missing file, an
// undecodable one, *and* a record lacking `version`/`instanceId`. So a `coordinator.json` truncated mid-write,
// or written by a build whose shape this one rejects, reported a confident absence while a coordinator was
// serving on the socket.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendInfo, DiscoveryRead } from '#src/infra/backend-discovery.js';

const mockState = vi.hoisted(() => ({
  info: null as BackendInfo | null,
  read: { kind: 'missing' } as DiscoveryRead,
}));

vi.mock('#src/infra/backend-discovery.js', () => ({
  readBackendInfo: vi.fn(() => mockState.info),
  readDiscoveryRecordDisposition: vi.fn(() => mockState.read),
}));

vi.mock('#src/infra/bundle-manifest.js', () => ({
  readBuildFlavor: vi.fn(() => 'prod'),
}));

const livenessMock = vi.hoisted(() => vi.fn<() => 'alive' | 'absent' | 'unknown'>(() => 'absent'));
vi.mock('#src/infra/node-process.js', () => ({
  observeProcessLiveness: livenessMock,
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
    paths: { coral: { coordinator: { startupDiagnosticFile: '/tmp/coral-startup.json' } } },
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
    mockState.info = null;
    mockState.read = { kind: 'missing' };
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
    mockState.read = { kind: 'record', record: preVersion };
    mockState.info = null;
    livenessMock.mockReturnValue('alive');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');
    const result = await getBackendStatusFull('/plugin-root');

    // What this change establishes: the daemon is asked at all. Before it, `readBackendInfo` answered `null`
    // for this record and the function short-circuited to a not-running report without dialling anything.
    expect(fetchMock, 'the record carries host, port and bootToken, so the daemon can be asked').toHaveBeenCalled();
    // What it does not establish, deliberately: the eventual status. A daemon that answers badly still routes
    // through `unreachableStatus`, which reports `not_running` for "we reached something and it was wrong" —
    // the same collapse one layer out, pre-dating this branch and not narrowed here.
    expect(result.status).toBe('not_running');
    vi.unstubAllGlobals();
    livenessMock.mockReturnValue('absent');
  });

  it.each([['corrupt-json'], ['shape-rejected']] as const)(
    'reports the %s record as its own status, not as an absent coordinator',
    async (reason) => {
      mockState.read = { kind: 'undecodable', reason };
      // The record-derived view is still populated here, so a consumer reading only that would fall through to
      // the liveness check and report `not_running` — the collapse this branch exists to stop.
      mockState.info = backendInfo();

      const { getBackendStatusFull } = await import('#src/transport/http/backend/status.js');

      await expect(getBackendStatusFull('/plugin-root')).resolves.toEqual({
        status: 'undecodable_record',
        reason,
      });
    },
  );
});
