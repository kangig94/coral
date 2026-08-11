import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { coordinatorHttpRoutes, createHttpHandler } from '#src/transport/http/handler.js';
import { recoveryQuarantineClearRpcSpec, rpcCatalog } from '#src/transport/rpc/catalog.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';

const httpServers: Server[] = [];

afterEach(async () => {
  for (const server of httpServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function recoveryPorts(clear: HttpHandlerPorts['recoveryQuarantine']): HttpHandlerPorts {
  return {
    identity: {
      pluginRoot: '/plugin-root',
      token: 'backend-token',
      bootToken: 'boot-token',
      shutdownToken: 'shutdown-token',
      version: '0.10.4',
      bundleHash: 'bundle-hash',
      flavor: 'prod',
      namespace: 'test-namespace',
      instanceId: 'coordinator-1',
      now: () => 0,
      log: vi.fn(),
    },
    coralEnvSnapshot: {},
    admin: {
      isLifecycleRunning: () => true,
      isDrainRequested: () => false,
      isLaunchFenceActive: () => false,
      beginRequest: vi.fn(),
      endRequest: vi.fn(),
      requestDrain: vi.fn(),
    },
    recoveryQuarantine: clear,
  } as unknown as HttpHandlerPorts;
}

async function startHttpServer(ports: HttpHandlerPorts): Promise<string> {
  const server = createServer((req, res) => {
    void createHttpHandler(ports)(req, res);
  });
  httpServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected TCP server address');
  }
  return `http://127.0.0.1:${address.port}`;
}

describe('transport/http backend communication', () => {
  it('projects recovery quarantine clear without widening HTTP backend-token capabilities', async () => {
    const clear = vi.fn();
    const ports = recoveryPorts({ clear });
    const baseUrl = await startHttpServer(ports);
    const catalogSpec = rpcCatalog.find((spec) => spec.name === 'coordinator.recovery_quarantine.clear');

    expect(catalogSpec).toBe(recoveryQuarantineClearRpcSpec);
    expect(coordinatorHttpRoutes).toContainEqual({
      method: 'POST',
      path: '/coordinator/recovery-quarantine/clear',
      spec: recoveryQuarantineClearRpcSpec,
    });

    const response = await fetch(`${baseUrl}${recoveryQuarantineClearRpcSpec.http.path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': ports.identity.token,
      },
      body: JSON.stringify({
        boundary: 'workflow-recovery',
        key: 'workflow-1',
        revision: 'revision-1',
      }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'missing_capability' });
    expect(clear).not.toHaveBeenCalled();
  });

  it.each([
    ['X-Coral-Boot-Token', 'boot-token'],
    ['X-Coral-Shutdown-Token', 'shutdown-token'],
  ])('does not accept the operational %s for catalog mutations', async (header, token) => {
    const clear = vi.fn();
    const ports = recoveryPorts({ clear });
    const baseUrl = await startHttpServer(ports);

    const response = await fetch(`${baseUrl}${recoveryQuarantineClearRpcSpec.http.path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [header]: token,
      },
      body: JSON.stringify({ boundary: 'workflow-recovery', key: 'workflow-1', revision: 'revision-1' }),
    });

    expect(response.status).toBe(401);
    expect(clear).not.toHaveBeenCalled();
  });

  it('validates the catalog input before invoking recovery retry authority', async () => {
    const clear = vi.fn();
    const ports = recoveryPorts({ clear });
    const baseUrl = await startHttpServer(ports);

    const response = await fetch(`${baseUrl}${recoveryQuarantineClearRpcSpec.http.path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': ports.identity.token,
      },
      body: JSON.stringify({ boundary: 'workflow-recovery', key: 'workflow-1' }),
    });

    expect(response.status).toBe(400);
    expect(clear).not.toHaveBeenCalled();
  });
});
