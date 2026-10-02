import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BackendInfo } from '#src/infra/backend-discovery.js';
import type { CoordinatorObservation } from '#src/transport/http/backend/coordinator-observation.js';

const NOW = 1_700_000_000_000;
const PID = 12_345;
const STARTED_AT = NOW - 100_000;
const mockState = vi.hoisted(() => ({
  observed: { kind: 'no-record' } as CoordinatorObservation,
  diagnostic: null as string | null,
}));

vi.mock('#src/transport/http/backend/coordinator-observation.js', () => ({
  observeCoordinator: () => mockState.observed,
}));
vi.mock('#src/infra/bundle-manifest.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readBuildFlavor: () => 'prod',
  resolveStrictBundleIdentity: () => ({ ok: false, reason: 'embedded_identity_unavailable' }),
}));
vi.mock('#src/transport/ipc/health.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readIdentityCheckedAuthenticatedHealth: async () => ({ kind: 'unavailable', cause: 'transport-failure' }),
}));
vi.mock('#src/runtime/real.js', () => ({
  createRealRuntime: () => ({
    storage: {
      lstatSync: () => {
        throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      },
      readFileSync: (path: string) => {
        if (path === '/batch-08-fake/startup.json' && mockState.diagnostic !== null) return mockState.diagnostic;
        throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      },
    },
    env: { platform: () => 'linux' },
    time: { now: () => NOW },
    paths: {
      coral: {
        coordinator: {
          runDir: '/batch-08-fake/run',
          startupDiagnosticFile: '/batch-08-fake/startup.json',
          infoFile: '/batch-08-fake/coordinator.json',
          socketPath: '/batch-08-fake/coordinator.sock',
        },
      },
    },
  }),
}));

import { getBackendStatusFull } from '#src/cli/backend-status.js';

const healthyPing = {
  status: 'ok',
  version: '0.0.0',
  bundleHash: 'bundle-hash',
  flavor: 'prod',
  instanceId: 'test-instance',
  namespace: 'test-namespace',
  pid: PID,
};

const coordinator: BackendInfo = {
  pid: PID,
  port: 4321,
  host: '127.0.0.1',
  socketPath: '/batch-08-fake/coordinator.sock',
  token: 'backend-token',
  bootToken: 'boot-token',
  version: '0.0.0',
  bundleHash: 'bundle-hash',
  flavor: 'prod',
  namespace: 'test-namespace',
  instanceId: 'test-instance',
  startedAt: STARTED_AT,
};

function diagnostic(recordedAt: number, pid: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    state: 'stopped_with_diagnostic',
    retryable: false,
    phase: 'startup_failed',
    recordedAt: new Date(recordedAt).toISOString(),
    pid,
    error: { kind: 'other' },
  });
}

beforeEach(() => {
  mockState.observed = { kind: 'addressed', coordinator, pidLiveness: 'alive' };
  mockState.diagnostic = null;
});
afterEach(() => vi.unstubAllGlobals());

it('scopes a startup failure by both PID and start time when a PID is reused', async () => {
  mockState.observed = { kind: 'process-absent', pid: PID, startedAt: STARTED_AT, instanceId: 'test-instance' };
  mockState.diagnostic = diagnostic(STARTED_AT + 10_000, PID);
  await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({ status: 'recent_failure' });

  mockState.diagnostic = diagnostic(STARTED_AT - 10_000, PID);
  await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
    status: 'recorded_process_absent',
    pid: PID,
  });

  mockState.diagnostic = diagnostic(STARTED_AT + 10_000, PID + 1);
  await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
    status: 'recorded_process_absent',
    pid: PID,
  });
});

it('rejects terminal control text at detailed-health ingress', async () => {
  const health = {
    status: 'ok',
    kernel: { phase: 'running', readyAt: NOW - 1_000 },
    version: '0.0.0',
    bundleHash: 'bundle-hash',
    flavor: 'prod',
    instanceId: 'test-instance',
    namespace: 'foreign\u001b[2J\nNext step: run a forged command',
    pid: PID,
    uptimeMs: 1_000,
    active: 0,
    activeJobs: 0,
    inflightRequests: 0,
    queueDepth: 0,
    textProjectionState: 'idle',
    components: [],
  };
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(healthyPing)))
      .mockResolvedValueOnce(new Response(JSON.stringify(health))),
  );

  const result = await getBackendStatusFull('/plugin-root');

  expect(result).toMatchObject({
    status: 'unreachable',
    cause: 'responded',
    detail: 'detailed health responded 200 with a body this build could not decode',
  });
  expect(JSON.stringify(result)).not.toContain('forged');
  expect(JSON.stringify(result)).not.toContain('\u001b');
});

it('distinguishes a 401 responder from unreachable transport', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(healthyPing)))
      .mockResolvedValueOnce(new Response('{}', { status: 401 })),
  );
  await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({ status: 'unauthorized' });

  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
  await expect(getBackendStatusFull('/plugin-root')).resolves.toMatchObject({
    status: 'unreachable',
    cause: 'no_response',
  });
});
