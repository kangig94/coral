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

vi.mock('#src/infra/node-process.js', () => ({
  observeProcessLiveness: vi.fn(() => 'absent'),
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
