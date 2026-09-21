import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { IpcLifecycleRefusal, requestIpcMethod } from '#src/transport/ipc/client.js';
import { closeIpcServer, createIpcServer, listenIpcServer } from '#src/transport/ipc/server.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import type { ProviderProxySetAddress } from '#src/provider-proxy/set-address.js';
import type { ProviderProxySetContainResponse } from '#src/transport/rpc/catalog.js';
import { ProviderHostAdministrationError } from '#src/coordinator/services/provider-host-administration.js';
import type { HostRef } from '#src/providers/contract.js';

const tempRoots: string[] = [];
const PROJECT_ROOT = realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)));
const setIdentity: ProviderProxySetAddress = {
  buildSetId: '11111111-1111-4111-8111-111111111111',
  hostFingerprint: 'a'.repeat(64),
  proxyInstanceId: '22222222-2222-4222-8222-222222222222',
};

const providerHostRef: HostRef = {
  provider: 'codex',
  fingerprint: 'b'.repeat(64),
  instanceId: '33333333-3333-4333-8333-333333333333',
  leaseMode: 'shared',
};
const providerHostRow = {
  ref: providerHostRef,
  status: 'shutdown-held' as const,
  spec: {
    provider: 'codex',
    command: 'codex',
    args: ['app-server'],
    cwd: null,
    leaseMode: 'shared' as const,
    idleRetirement: 'never' as const,
  },
  host: {
    owner: 'coordinator' as const,
    hostKey: 'held-host-key',
    identityKey: 'held-host-identity-key',
    ownerJobId: null,
    pid: 4321,
    processGroupId: 4321,
    observation: 'unobservable' as const,
    successorOwner: null,
    operatorExit: 'retry-provider-shutdown',
  },
  diagnostics: {
    hostLog: { entries: [], retainedBytes: 0, truncatedBeforeSeq: 0 },
    completedObservations: [],
    factsTruncatedBeforeSeq: 0,
  },
  diagnosticsRetention: { ownerBudgetTruncated: false },
  ownerId: 'coordinator:test-instance',
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
      list: vi.fn(() => []),
    },
    providerProxySets: {
      contain: vi.fn(async () => containmentResult(containmentKind)),
      containBoolean: vi.fn(async () => containmentResult(containmentKind)),
    },
    providerHosts: {
      list: vi.fn(async () => ({ hosts: [providerHostRow], tornDownOwnerIds: [] })),
      inspect: vi.fn(async () => ({ host: providerHostRow })),
      evict: vi.fn(async () => ({ ownerId: providerHostRow.ownerId, hostRef: providerHostRef })),
    },
  } as unknown as HttpHandlerPorts;
}

function createRunningPorts(): HttpHandlerPorts {
  const draining = createDrainingPorts('contained');
  return {
    ...draining,
    admin: {
      ...draining.admin,
      getLifecycleState: () => 'running',
      isLifecycleRunning: () => true,
      isDrainRequested: () => false,
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

// Every `wakeRetainedShutdown` negative below must be asserted after the `finally` close: while the socket
// is still open, not-woken is indistinguishable from not-yet-woken.
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
    {
      method: 'coordinator.provider_host.evict',
      params: { hostRef: providerHostRef },
      invoked: (ports: HttpHandlerPorts) => ports.providerHosts?.evict,
      containmentKind: undefined,
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

  it.each([
    {
      outcome: 'operator abandonment',
      result: {
        aborted: [],
        notFound: [],
        abandoned: [
          {
            jobId: 'held-job',
            reason: 'cleanup ownership released by operator',
            nextStep: 'inspect the process outside Coral',
          },
        ],
      },
    },
    {
      outcome: 'nothing left to abort',
      result: { aborted: [], notFound: ['held-job'] },
    },
  ])('wakes retained shutdown after jobs.abort reports $outcome', async ({ result }) => {
    const ports = createDrainingPorts();
    ports.jobs.abort = vi.fn(() => result);
    const listener = createIpcServer(ports);
    const retryShutdown = vi.fn();
    listener.onShutdownRecoveryAccepted = retryShutdown;
    const path = socketPath();
    await listenIpcServer(listener, path);

    try {
      await expect(
        requestIpcMethod(
          path,
          'jobs.abort',
          { jobs: ['held-job'], projectRoot: PROJECT_ROOT },
          { auth: { kind: 'boot', token: 'boot-token' } },
        ),
      ).resolves.toEqual(result);
      await vi.waitFor(() => expect(retryShutdown).toHaveBeenCalledOnce());
      expect(ports.jobs.abort).toHaveBeenCalledOnce();
    } finally {
      await closeIpcServer(listener);
    }
  });

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

  it.each([
    {
      route: 'list',
      method: 'coordinator.provider_host.list',
      params: {},
      invoked: (ports: HttpHandlerPorts) => ports.providerHosts?.list,
      expected: { hosts: [providerHostRow] },
    },
    {
      route: 'list.v2',
      method: 'coordinator.provider_host.list.v2',
      params: {},
      invoked: (ports: HttpHandlerPorts) => ports.providerHosts?.list,
      expected: { hosts: [providerHostRow], tornDownOwnerIds: [] },
    },
    {
      route: 'inspect',
      method: 'coordinator.provider_host.inspect',
      params: { hostRef: providerHostRef },
      invoked: (ports: HttpHandlerPorts) => ports.providerHosts?.inspect,
      expected: { host: providerHostRow },
    },
  ])(
    'observes provider hosts through $route while draining without waking the retained shutdown',
    async ({ method, params, invoked, expected }) => {
      const ports = createDrainingPorts();
      const listener = createIpcServer(ports);
      const wakeRetainedShutdown = vi.fn();
      listener.onShutdownRecoveryAccepted = wakeRetainedShutdown;
      const path = socketPath();
      await listenIpcServer(listener, path);

      try {
        await expect(
          requestIpcMethod(path, method, params, { auth: { kind: 'boot', token: 'boot-token' } }),
        ).resolves.toEqual(expected);
        expect(invoked(ports)).toHaveBeenCalledOnce();
      } finally {
        await closeIpcServer(listener);
      }
      expect(wakeRetainedShutdown).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      refusal: 'a shutdown hold',
      error: new ProviderHostAdministrationError('provider_host_shutdown_held', {
        ownerIds: [providerHostRow.ownerId],
        matches: [providerHostRef],
        hold: {
          kind: 'held',
          observation: 'unobservable',
          successorOwner: null,
          operatorExit: 'retry-provider-shutdown',
        },
      }),
      code: 'provider_host_shutdown_held',
    },
    {
      refusal: 'a torn-down owner',
      error: new ProviderHostAdministrationError('provider_host_owner_torn_down', {
        ownerIds: ['provider-proxy:22222222-2222-4222-8222-222222222222'],
        matches: [providerHostRef],
      }),
      code: 'provider_host_owner_torn_down',
    },
  ])('keeps the retained shutdown held when eviction answers $refusal', async ({ error, code }) => {
    const ports = createDrainingPorts();
    ports.providerHosts!.evict = vi.fn(async () => {
      throw error;
    });
    const listener = createIpcServer(ports);
    const wakeRetainedShutdown = vi.fn();
    listener.onShutdownRecoveryAccepted = wakeRetainedShutdown;
    const path = socketPath();
    await listenIpcServer(listener, path);

    try {
      await expect(
        requestIpcMethod(
          path,
          'coordinator.provider_host.evict',
          { hostRef: providerHostRef },
          { auth: { kind: 'boot', token: 'boot-token' } },
        ),
      ).rejects.toMatchObject({ data: { code } });
      expect(ports.providerHosts?.evict).toHaveBeenCalledOnce();
    } finally {
      await closeIpcServer(listener);
    }
    expect(wakeRetainedShutdown).not.toHaveBeenCalled();
  });

  // Arming the continuation without the `draining` precondition would call `requestShutdownRetry` on a
  // coordinator with no shutdown in flight, which starts one.
  it.each([
    {
      method: 'jobs.abort',
      params: { jobs: ['live-job'], projectRoot: PROJECT_ROOT },
      invoked: (ports: HttpHandlerPorts) => ports.jobs.abort,
    },
    {
      method: 'coordinator.provider_proxy_set.contain.v2',
      params: { setIdentity, mode: 'contain' },
      invoked: (ports: HttpHandlerPorts) => ports.providerProxySets?.contain,
    },
    {
      method: 'coordinator.provider_host.evict',
      params: { hostRef: providerHostRef },
      invoked: (ports: HttpHandlerPorts) => ports.providerHosts?.evict,
    },
  ])('never drains a healthy coordinator after a successful $method', async ({ method, params, invoked }) => {
    const ports = createRunningPorts();
    const listener = createIpcServer(ports);
    const wakeRetainedShutdown = vi.fn();
    listener.onShutdownRecoveryAccepted = wakeRetainedShutdown;
    const path = socketPath();
    await listenIpcServer(listener, path);

    try {
      await expect(
        requestIpcMethod(path, method, params, { auth: { kind: 'boot', token: 'boot-token' } }),
      ).resolves.toBeDefined();
      expect(invoked(ports)).toHaveBeenCalledOnce();
    } finally {
      await closeIpcServer(listener);
    }
    expect(wakeRetainedShutdown).not.toHaveBeenCalled();
  });

  it('keeps unrelated catalog methods closed while draining', async () => {
    const ports = createDrainingPorts();
    const listener = createIpcServer(ports);
    const path = socketPath();
    await listenIpcServer(listener, path);

    try {
      const refused = await requestIpcMethod(
        path,
        'jobs.list',
        { projectRoot: PROJECT_ROOT },
        { auth: { kind: 'boot', token: 'boot-token' } },
      ).then(
        (result: unknown) => result,
        (error: unknown) => error,
      );

      expect(refused).toBeInstanceOf(IpcLifecycleRefusal);
      expect(refused).toMatchObject({
        code: 'backend_shutting_down',
        method: 'jobs.list',
        socketPath: path,
      });
      // Re-issuing a refused method against a successor may repeat no work, so the refusal must precede the
      // port call, not follow it.
      expect(ports.jobs.list).not.toHaveBeenCalled();
    } finally {
      await closeIpcServer(listener);
    }
  });

  it('refuses a drain-admitted method on a stopped lifecycle without running it', async () => {
    const draining = createDrainingPorts();
    const ports = {
      ...draining,
      admin: {
        ...draining.admin,
        getLifecycleState: () => 'stopped',
        isDrainRequested: () => false,
        isLifecycleRunning: () => false,
      },
    } as unknown as HttpHandlerPorts;
    const listener = createIpcServer(ports);
    const path = socketPath();
    await listenIpcServer(listener, path);

    try {
      const refused = await requestIpcMethod(
        path,
        'jobs.abort',
        { jobs: ['held-job'], projectRoot: PROJECT_ROOT },
        { auth: { kind: 'boot', token: 'boot-token' } },
      ).then(
        (result: unknown) => result,
        (error: unknown) => error,
      );

      expect(refused).toBeInstanceOf(IpcLifecycleRefusal);
      expect(refused).toMatchObject({
        code: 'backend_shutting_down',
        method: 'jobs.abort',
        socketPath: path,
      });
      expect(ports.jobs.abort).not.toHaveBeenCalled();
    } finally {
      await closeIpcServer(listener);
    }
  });
});
