import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { AppServerProxyRouteRequest } from '#src/jobs/contracts/app-server-proxy-route.js';
import type { DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { createAppServerProxyRoute } from '#src/coordinator/services/provider-proxy-launch-route.js';

const request: AppServerProxyRouteRequest = {
  jobId: randomUUID(),
  operationId: randomUUID(),
  hostSpec: {
    provider: 'codex',
    command: 'codex',
    args: ['app-server'],
    cwd: '/workspace',
    leaseMode: 'job-exclusive',
  },
  provider: 'codex',
  binding: { provider: 'codex', kind: 'account', binding: { account: 'acct-1' } },
  request: {
    action: 'exec',
    sessionId: 'session-1',
    prompt: 'do the thing',
    cwd: '/workspace',
    bypassPermissions: false,
    coralEnv: {},
  },
  persistedContinuity: null,
  baseEnv: { PATH: '/usr/bin' },
  protectedEnv: {},
  platform: 'linux',
};

function authority(): DurableProviderProxyOperationAuthority {
  const proxyInstanceId = randomUUID();
  const buildSetId = randomUUID();
  return {
    proxyInstanceId,
    setIdentity: {
      buildSetId,
      hostFingerprint: 'a'.repeat(64),
      guardianInstanceId: randomUUID(),
      guardianPid: 100,
      guardianProcessStartedAtSeconds: 1,
      guardianControlEndpoint: '/tmp/guardian.sock',
      proxyInstanceId,
      proxyPid: 200,
      reaperInstanceId: randomUUID(),
      reaperPid: 300,
      reaperProcessStartedAtSeconds: 2,
      reaperControlEndpoint: '/tmp/reaper.sock',
      containmentKind: 'detached-group',
      proxyProcessStartedAtSeconds: 3,
      proxyProcessGroupId: 200,
      canonicalEndpoint: '/tmp/proxy.sock',
    },
    snapshotOperations: async () => [],
    installHandoffGrant: async () => undefined,
    stopAndReap: async () => ({ disappearanceReceipt: 'gone' }),
    stopHeartbeats: () => undefined,
    initiateControlClose: async () => undefined,
    prepareOperation: vi.fn(),
    inspectOperation: vi.fn(),
    authorizeOperation: vi.fn(),
    activatePreparedOperation: vi.fn(),
    cancelOperation: vi.fn(),
    settleOperation: vi.fn(),
    buildOperationControl: vi.fn(),
  };
}

describe('createAppServerProxyRoute', () => {
  it('authorizes local placement before creating an operation when no live set exists', async () => {
    const begin = vi.fn();
    const route = createAppServerProxyRoute({
      hostManager: { routeAppServerOperation: () => null },
      reconciler: { begin },
      now: () => 10,
    });

    await expect(route.activate(request, vi.fn(), new AbortController().signal)).resolves.toMatchObject({
      kind: 'local-authorized',
    });
    expect(begin).not.toHaveBeenCalled();
  });

  it('returns cancelled without routing or journalling an already-aborted launch', async () => {
    const routeAppServerOperation = vi.fn();
    const begin = vi.fn();
    const route = createAppServerProxyRoute({
      hostManager: { routeAppServerOperation },
      reconciler: { begin },
      now: () => 10,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(route.activate(request, vi.fn(), controller.signal)).resolves.toEqual({ kind: 'cancelled' });
    expect(routeAppServerOperation).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
  });

  it('hands a prepare-pending row and the exact prepared envelope to the reconciler', async () => {
    const set = authority();
    const begin = vi.fn(async () => ({ kind: 'remote-executing' as const }));
    const route = createAppServerProxyRoute({
      hostManager: { routeAppServerOperation: () => set },
      reconciler: { begin },
      now: () => 10,
    });
    const release = vi.fn();

    await expect(route.activate(request, release, new AbortController().signal)).resolves.toEqual({
      kind: 'remote-executing',
    });
    expect(begin).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: set,
        release,
        request,
        record: expect.objectContaining({
          phase: 'prepare-pending',
          revision: 0,
          operation: expect.objectContaining({
            jobId: request.jobId,
            operationId: request.operationId,
            proxyInstanceId: set.proxyInstanceId,
            buildSetId: set.setIdentity.buildSetId,
          }),
        }),
        prepared: expect.objectContaining({ version: 1, provider: request.provider }),
      }),
    );
  });

  it('fails closed when a selected set lacks durable replay operations', async () => {
    const set = authority();
    const { prepareOperation: _prepare, ...legacy } = set;
    const begin = vi.fn();
    const route = createAppServerProxyRoute({
      hostManager: { routeAppServerOperation: () => legacy },
      reconciler: { begin },
      now: () => 10,
    });

    await expect(route.activate(request, vi.fn(), new AbortController().signal)).resolves.toMatchObject({
      kind: 'failed',
    });
    expect(begin).not.toHaveBeenCalled();
  });
});
