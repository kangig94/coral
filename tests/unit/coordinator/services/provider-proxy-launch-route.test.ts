import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { AppServerProxyRouteRequest } from '#src/jobs/contracts/app-server-proxy-route.js';
import type { DurableProviderProxyOperationAuthority } from '#src/coordinator/live/provider-proxy/operation-route.js';
import { createAppServerProxyRoute } from '#src/coordinator/services/provider-proxy-launch-route.js';

const request: AppServerProxyRouteRequest = {
  jobId: randomUUID(),
  operationId: randomUUID(),
  jobLaunchEventSeq: 41,
  sessionId: randomUUID(),
  sessionVersion: 3,
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
  childAuthorization: {
    principalWire: {
      subject: 'agent',
      binding: { kind: 'project', root: '/workspace' },
      attenuatedCaps: ['liveness', 'jobs:read'],
    },
    namespace: 'tests',
    expiresAtMs: 60_000,
  },
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
    registerSuccessionOperation: async () => undefined,
    installHandoffGrant: async () => undefined,
    stopAndReap: async () => ({ disappearanceReceipt: 'gone' }),
    stopHeartbeats: () => undefined,
    initiateControlClose: async () => undefined,
    prepareOperation: vi.fn(),
    inspectOperation: vi.fn(),
    authorizeOperation: vi.fn(),
    activatePreparedOperation: vi.fn(),
    attachOperation: vi.fn(),
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

    await expect(route.activate(request, new AbortController().signal)).resolves.toMatchObject({
      kind: 'local-authorized',
    });
    expect(begin).not.toHaveBeenCalled();
  });

  it('passes an already-aborted launch into the write-ahead publication boundary', async () => {
    const set = authority();
    const routeAppServerOperation = vi.fn(() => set);
    const begin = vi.fn(async () => ({ kind: 'terminalized' as const }));
    const route = createAppServerProxyRoute({
      hostManager: { routeAppServerOperation },
      reconciler: { begin },
      now: () => 10,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(route.activate(request, controller.signal)).resolves.toEqual({ kind: 'terminalized' });
    expect(routeAppServerOperation).toHaveBeenCalledOnce();
    expect(begin).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });

  it('hands the reconciler a source-complete row and its exact journaled attempt', async () => {
    const set = authority();
    const begin = vi.fn(async () => ({ kind: 'remote-executing' as const }));
    const route = createAppServerProxyRoute({
      hostManager: { routeAppServerOperation: () => set },
      reconciler: { begin },
      now: () => 10,
    });
    await expect(route.activate(request, new AbortController().signal)).resolves.toEqual({
      kind: 'remote-executing',
    });
    expect(begin).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: set,
        record: expect.objectContaining({
          phase: 'prepare-pending',
          prepareAttemptNumber: 1,
          prepareSource: {
            jobLaunchEventSeq: request.jobLaunchEventSeq,
            sessionId: request.sessionId,
            sessionVersion: request.sessionVersion,
            platform: request.platform,
            childAuthorization: request.childAuthorization,
          },
          revision: 0,
          operation: expect.objectContaining({
            jobId: request.jobId,
            operationId: request.operationId,
            proxyInstanceId: set.proxyInstanceId,
            buildSetId: set.setIdentity.buildSetId,
          }),
        }),
        attempt: expect.objectContaining({
          request: expect.objectContaining({
            prepareAttemptNumber: 1,
            operation: expect.objectContaining({ jobId: request.jobId, operationId: request.operationId }),
            prepared: expect.objectContaining({ version: 1, provider: request.provider }),
          }),
        }),
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

    await expect(route.activate(request, new AbortController().signal)).resolves.toMatchObject({
      kind: 'failed',
    });
    expect(begin).not.toHaveBeenCalled();
  });
});
