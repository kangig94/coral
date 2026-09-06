import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { requestIpcMethod } from '#src/transport/ipc/client.js';
import { closeIpcServer, createIpcServer, listenIpcServer } from '#src/transport/ipc/server.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import type { ProviderProxySetAddress } from '#src/provider-proxy/set-address.js';
import type { ProviderProxySetContainResponse } from '#src/transport/rpc/catalog.js';

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

function containmentResult(kind: 'contained' | 'abandoned'): ProviderProxySetContainResponse {
  const effect = {
    signalsSent: [],
    containmentAbsent: kind === 'contained',
    representationAction:
      kind === 'contained' ? ('absence-release-started' as const) : ('abandonment-release-started' as const),
  };
  if (kind === 'contained') {
    return {
      kind,
      setIdentity,
      disappearanceReceipt: 'disappearance-receipt',
      claimDischarge: { kind: 'completed' },
      effect,
    };
  }
  return {
    kind,
    setIdentity,
    enforcerObservations: [
      { role: 'guardian', observation: 'unknown' },
      { role: 'reaper', observation: 'unknown' },
    ],
    claimDischarge: { kind: 'completed' },
    effect,
  };
}

function concurrentlyResolvedContainmentResult(
  kind: 'set-not-found' | 'not-held' | 'authorization-stale',
): ProviderProxySetContainResponse {
  const effect = { signalsSent: [], containmentAbsent: false, representationAction: 'none' as const };
  if (kind === 'not-held') return { kind, setIdentity, state: 'containment-wait', effect };
  return { kind, setIdentity, effect };
}

function createDrainingPorts(containmentKind: 'contained' | 'abandoned' = 'abandoned'): HttpHandlerPorts {
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
      contain: vi.fn(async () => containmentResult(containmentKind)),
      containBoolean: vi.fn(async () => containmentResult(containmentKind)),
    },
  } as unknown as HttpHandlerPorts;
}

async function connectRawIpcSocket(path: string): Promise<Socket> {
  const socket = createConnection(path);
  socket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function writeContainmentRequest(socket: Socket): void {
  socket.write(
    `${JSON.stringify({
      kind: 'request',
      id: 1,
      method: 'coordinator.provider_proxy_set.contain.v2',
      params: { setIdentity, mode: 'contain' },
      auth: { kind: 'boot', token: 'boot-token' },
    })}\n`,
  );
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
      containmentKind: undefined,
    },
    {
      method: 'coordinator.provider_proxy_set.contain.v2',
      params: { setIdentity, mode: 'abandon' },
      invoked: (ports: HttpHandlerPorts) => ports.providerProxySets?.contain,
      containmentKind: 'abandoned' as const,
    },
    {
      method: 'coordinator.provider_proxy_set.contain.v2',
      params: { setIdentity, mode: 'contain' },
      invoked: (ports: HttpHandlerPorts) => ports.providerProxySets?.contain,
      containmentKind: 'contained' as const,
    },
    {
      method: 'coordinator.provider_proxy_set.contain',
      params: { setIdentity, abandonWithoutAbsence: false },
      invoked: (ports: HttpHandlerPorts) => ports.providerProxySets?.containBoolean,
      containmentKind: 'contained' as const,
    },
  ])(
    'keeps $method authenticated and wakes retained shutdown after an accepted response',
    async ({ method, params, invoked, containmentKind }) => {
      const ports = createDrainingPorts(containmentKind);
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

  it('wakes retained shutdown when the client disconnects before a successful containment returns', async () => {
    const ports = createDrainingPorts('contained');
    let finishContainment!: () => void;
    const containmentFinished = new Promise<void>((resolve) => {
      finishContainment = resolve;
    });
    ports.providerProxySets!.contain = vi.fn(async () => {
      await containmentFinished;
      return containmentResult('contained');
    });
    const listener = createIpcServer(ports);
    const wakeRetainedShutdown = vi.fn();
    listener.onShutdownRecoveryAccepted = wakeRetainedShutdown;
    const path = socketPath();
    await listenIpcServer(listener, path);
    const socket = await connectRawIpcSocket(path);

    try {
      writeContainmentRequest(socket);
      await vi.waitFor(() => expect(ports.providerProxySets?.contain).toHaveBeenCalledOnce());
      socket.destroy();
      await vi.waitFor(() => expect(listener.sockets.size).toBe(0));
      finishContainment();

      await vi.waitFor(() => expect(wakeRetainedShutdown).toHaveBeenCalledOnce());
    } finally {
      finishContainment();
      socket.destroy();
      await closeIpcServer(listener);
    }
  });

  it('wakes retained shutdown exactly once when the containment response drain times out', async () => {
    const ports = createDrainingPorts('contained');
    const listener = createIpcServer(ports, { writeDrainTimeoutMs: 1 });
    const wakeRetainedShutdown = vi.fn();
    listener.onShutdownRecoveryAccepted = wakeRetainedShutdown;
    const path = socketPath();
    await listenIpcServer(listener, path);
    const socket = await connectRawIpcSocket(path);

    try {
      await vi.waitFor(() => expect(listener.sockets.size).toBe(1));
      const serverSocket = [...listener.sockets].at(0);
      if (serverSocket === undefined) throw new Error('server socket was not retained');
      serverSocket.write = vi.fn(() => false);
      writeContainmentRequest(socket);

      await vi.waitFor(() => expect(serverSocket.destroyed).toBe(true));
      await vi.waitFor(() => expect(wakeRetainedShutdown).toHaveBeenCalledOnce());
      expect(ports.providerProxySets?.contain).toHaveBeenCalledOnce();
    } finally {
      socket.destroy();
      await closeIpcServer(listener);
    }
  });

  it.each(['set-not-found', 'not-held', 'authorization-stale'] as const)(
    'wakes retained shutdown when concurrent lifecycle recovery makes containment return %s',
    async (kind) => {
      const ports = createDrainingPorts();
      const result = concurrentlyResolvedContainmentResult(kind);
      ports.providerProxySets!.contain = vi.fn(async () => result);
      const listener = createIpcServer(ports);
      const wakeRetainedShutdown = vi.fn();
      listener.onShutdownRecoveryAccepted = wakeRetainedShutdown;
      const path = socketPath();
      await listenIpcServer(listener, path);

      try {
        await expect(
          requestIpcMethod(
            path,
            'coordinator.provider_proxy_set.contain.v2',
            { setIdentity, mode: 'contain' },
            { auth: { kind: 'boot', token: 'boot-token' } },
          ),
        ).resolves.toEqual(result);
        await vi.waitFor(() => expect(wakeRetainedShutdown).toHaveBeenCalledOnce());
      } finally {
        await closeIpcServer(listener);
      }
    },
  );

  it('returns method-not-found before accepting a legacy request whose state needs the current response', async () => {
    const ports = createDrainingPorts();
    ports.providerProxySets!.containBoolean = vi.fn(async () => ({ kind: 'unsupported-contract' as const }));
    const listener = createIpcServer(ports);
    const wakeRetainedShutdown = vi.fn();
    listener.onShutdownRecoveryAccepted = wakeRetainedShutdown;
    const path = socketPath();
    await listenIpcServer(listener, path);

    try {
      await expect(
        requestIpcMethod(
          path,
          'coordinator.provider_proxy_set.contain',
          { setIdentity, abandonWithoutAbsence: true },
          { auth: { kind: 'boot', token: 'boot-token' } },
        ),
      ).rejects.toMatchObject({ rpcCode: -32601 });
      expect(ports.providerProxySets!.containBoolean).toHaveBeenCalledOnce();
      expect(ports.providerProxySets!.contain).not.toHaveBeenCalled();
      expect(wakeRetainedShutdown).not.toHaveBeenCalled();
    } finally {
      await closeIpcServer(listener);
    }
  });

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
