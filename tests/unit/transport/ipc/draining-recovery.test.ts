import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { requestIpcMethod } from '#src/transport/ipc/client.js';
import { closeIpcServer, createIpcServer, listenIpcServer } from '#src/transport/ipc/server.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import type { ProviderProxySetAddress } from '#src/provider-proxy/set-address.js';

const tempRoots: string[] = [];
const PROJECT_ROOT = realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)));
const setIdentity: ProviderProxySetAddress = {
  buildSetId: '11111111-1111-4111-8111-111111111111',
  hostFingerprint: 'a'.repeat(64),
  proxyInstanceId: '22222222-2222-4222-8222-222222222222',
};

function socketPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-draining-recovery-'));
  tempRoots.push(root);
  return join(root, 'coordinator.sock');
}

function createDrainingPorts(): HttpHandlerPorts {
  return {
    identity: {
      pluginRoot: '/plugin-root',
      token: 'token',
      bootToken: 'boot-token',
      shutdownToken: 'shutdown-token',
      version: 'test',
      bundleHash: 'test-bundle',
      flavor: 'prod',
      namespace: 'test-namespace',
      instanceId: 'test-instance',
      now: () => 0,
      log: vi.fn(),
    },
    coralEnvSnapshot: {},
    admin: {
      getLifecycleState: () => 'draining',
      isLifecycleRunning: () => false,
      isDrainRequested: () => true,
      isLaunchFenceActive: () => false,
      beginRequest: vi.fn(),
      endRequest: vi.fn(),
      requestDrain: vi.fn(),
    },
    jobs: {
      scopeCheck: vi.fn((jobs: string[]) => ({ valid: jobs, missing: [], mismatch: [] })),
      abort: vi.fn((jobs: string[]) => ({ aborted: jobs, notFound: [] })),
    },
    providerProxySets: {
      contain: vi.fn(async () => ({
        kind: 'abandoned' as const,
        setIdentity,
        enforcerObservations: [
          { role: 'guardian' as const, observation: 'unknown' as const },
          { role: 'reaper' as const, observation: 'unknown' as const },
        ],
        claimDischarge: { kind: 'completed' as const },
        effect: {
          signalsSent: [],
          containmentAbsent: false,
          representationAction: 'abandonment-release-started' as const,
        },
      })),
    },
  } as unknown as HttpHandlerPorts;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('draining IPC recovery ingress', () => {
  it.each([
    {
      method: 'jobs.abort',
      params: { jobs: ['held-job'], projectRoot: PROJECT_ROOT },
      invoked: (ports: HttpHandlerPorts) => ports.jobs.abort,
    },
    {
      method: 'coordinator.provider_proxy_set.contain',
      params: { setIdentity, mode: 'abandon' },
      invoked: (ports: HttpHandlerPorts) => ports.providerProxySets?.contain,
    },
  ])(
    'keeps $method authenticated and wakes retained shutdown after an accepted response',
    async ({ method, params, invoked }) => {
      const ports = createDrainingPorts();
      const listener = createIpcServer(ports);
      const wakeRetainedShutdown = vi.fn();
      listener.onShutdownRecoveryAccepted = wakeRetainedShutdown;
      const path = socketPath();
      await listenIpcServer(listener, path);

      try {
        await expect(requestIpcMethod(path, method, params)).rejects.toThrow(
          'IPC boot token or child principal required',
        );
        expect(invoked(ports)).not.toHaveBeenCalled();
        expect(wakeRetainedShutdown).not.toHaveBeenCalled();

        await expect(
          requestIpcMethod(path, method, params, { auth: { kind: 'boot', token: 'boot-token' } }),
        ).resolves.toBeDefined();
        await vi.waitFor(() => expect(wakeRetainedShutdown).toHaveBeenCalledOnce());
        expect(invoked(ports)).toHaveBeenCalledOnce();
      } finally {
        await closeIpcServer(listener);
      }
    },
  );

  it('keeps unrelated catalog methods closed while draining', async () => {
    const ports = createDrainingPorts();
    const listener = createIpcServer(ports);
    const path = socketPath();
    await listenIpcServer(listener, path);

    try {
      await expect(
        requestIpcMethod(
          path,
          'jobs.list',
          { projectRoot: PROJECT_ROOT },
          {
            auth: { kind: 'boot', token: 'boot-token' },
          },
        ),
      ).resolves.toEqual({ code: 'backend_shutting_down', message: 'Backend shutting down' });
    } finally {
      await closeIpcServer(listener);
    }
  });
});
