import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type * as HttpHandlerModule from '#src/transport/http/handler.js';

const capturedComposition = vi.hoisted(() => ({ ports: null as HttpHandlerPorts | null }));

vi.mock('#src/transport/http/handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpHandlerModule>();
  return {
    ...actual,
    createHttpHandler: (ports: HttpHandlerPorts) => {
      capturedComposition.ports = ports;
      return actual.createHttpHandler(ports);
    },
  };
});

import { closeIpcServer, createIpcServer, listenIpcServer } from '#src/transport/ipc/server.js';
import { IpcRpcError, requestIpcMethod } from '#src/transport/ipc/client.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';
import { backendLog } from '#src/infra/backend-log.js';
import { writeDiscoveryRecord } from '#src/infra/backend-discovery.js';
import type { Principal } from '#src/security/principal.js';
import { TEST_SYSTEM_PROVIDER_SCOPE } from '../../../helpers/provider-credentials.js';
import {
  createProviderHostCommandOperations,
  formatProviderHostInspect,
  formatProviderHostList,
  parseProviderHostSelector,
} from '#src/cli/commands/backend.js';
import type { HostRef } from '#src/providers/contract.js';
import { createCoordinatorCore } from '#src/coordinator/composition/index.js';
import type {
  ProviderHostAdministrationAuthority,
  ProviderHostManager,
} from '#src/coordinator/live/provider-hosts/index.js';
import type { ProviderHostInventoryRecord } from '#src/coordinator/services/provider-host-administration.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { canonicalizeWorkDir } from '#src/runtime/canonical-work-dir.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { createMockKbDaemonSupervisor } from '#tools/testing/kb-daemon-supervisor.js';
import { createHandoffCoresHarness } from '#tests/integration/coordinator/handoff-cores-harness.js';

const tempDirs: string[] = [];

function makeSocketPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-ipc-server-test-'));
  tempDirs.push(root);
  return join(root, 'coordinator.sock');
}

async function withTestTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

async function waitForCondition(condition: () => boolean, label: string): Promise<void> {
  await withTestTimeout(
    new Promise<void>((resolve) => {
      const poll = () => {
        if (condition()) {
          resolve();
          return;
        }
        setTimeout(poll, 5);
      };
      poll();
    }),
    label,
  );
}

async function connectRawIpcSocket(socketPath: string): Promise<Socket> {
  const socket = createConnection(socketPath);
  return await withTestTimeout(
    new Promise<Socket>((resolve, reject) => {
      const onConnect = () => {
        socket.off('error', onError);
        socket.on('error', () => undefined);
        resolve(socket);
      };
      const onError = (error: Error) => {
        socket.off('connect', onConnect);
        reject(error);
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    }),
    'raw IPC socket connect',
  );
}

function hasLogLine(ports: HttpHandlerPorts, text: string): boolean {
  return vi.mocked(ports.identity.log).mock.calls.some(([line]) => typeof line === 'string' && line.includes(text));
}

function createProductionProviderHostPorts(record: ProviderHostInventoryRecord) {
  const administration = {
    admissionSnapshot: () => ({ state: new Map(), tombstones: [] }),
    listProviderHosts: vi.fn(() => [record]),
    inspectProviderHost: vi.fn(() => record),
    evictHost: vi.fn(async () => true),
  };
  const providerHostManager = {
    openSession: async () => {
      throw new Error('provider-host session creation was not expected');
    },
    attachSession: async () => null,
    drainForHandoff: async () => undefined,
    shutdown: async () => undefined,
    routeAppServerOperation: () => null,
    ...administration,
  } satisfies ProviderHostManager & ProviderHostAdministrationAuthority;

  capturedComposition.ports = null;
  createCoordinatorCore(
    {
      runtime: createRealRuntime('prod'),
      storeFormat: currentCoralStoreFormat(),
      pluginRoot: process.cwd(),
      backendNamespace: 'provider-host-response-contract-test',
      bootSnapshot: {
        version: '1.0.0',
        bundleHash: '0123456789abcdef',
        flavor: 'prod',
        instanceId: 'test-instance',
        token: 'operator-token',
        bootToken: 'boot-token',
        shutdownToken: 'shutdown-token',
        now: () => 0,
        log: vi.fn(),
      },
      createServerFn: (handler) => createServer(handler),
      providerHostManager,
      kbDaemonSupervisor: createMockKbDaemonSupervisor(),
      getConsumerStuck: () => [],
    },
    async () => [],
  );

  const ports = capturedComposition.ports as HttpHandlerPorts | null;
  if (ports === null) {
    throw new Error('Production composition did not assemble transport ports.');
  }
  return { ports, administration };
}

function providerHostInventoryRecord(): ProviderHostInventoryRecord {
  return {
    ref: {
      provider: 'codex',
      fingerprint: 'a'.repeat(64),
      instanceId: 'host-instance',
      leaseMode: 'shared',
    },
    status: 'live',
    spec: {
      provider: 'codex',
      command: 'codex',
      args: ['app-server'],
      cwd: canonicalizeWorkDir(process.cwd(), process.cwd()),
      leaseMode: 'shared',
      idleRetirement: 'never',
    },
    host: { owner: 'coordinator' },
    diagnostics: {
      hostLog: { entries: [], retainedBytes: 0, truncatedBeforeSeq: 0 },
      completedObservations: [
        {
          factSeq: 1,
          generation: 2,
          requestId: 3,
          method: 'config/read',
          response: { kind: 'failure', rpcCode: -32_603, providerMessage: 'fixture', providerData: null },
          hostLog: {
            startSeq: 4,
            endSeq: 5,
            truncated: true,
            historical: [{ seq: 1, observedAt: 1, stream: 'stderr', text: 'before' }],
            during: [],
            after: [],
          },
        },
      ],
      factsTruncatedBeforeSeq: 0,
    },
    diagnosticsRetention: { ownerBudgetTruncated: false },
  };
}

function withMalformedInventoryCwd(record: ProviderHostInventoryRecord): ProviderHostInventoryRecord {
  return {
    ...record,
    spec: { ...record.spec, cwd: 'relative/provider-host' },
  } as unknown as ProviderHostInventoryRecord;
}

function createPorts(): HttpHandlerPorts {
  const requestDrain = vi.fn();

  return {
    identity: {
      pluginRoot: '/plugin-root',
      token: 'unused-for-ipc',
      bootToken: 'boot-token',
      shutdownToken: 'shutdown-token',
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod',
      namespace: 'test-namespace',
      instanceId: 'test-instance',
      now: () => 0,
      log: vi.fn(),
    },
    coralEnvSnapshot: {},
    systemProviderScope: TEST_SYSTEM_PROVIDER_SCOPE,
    admin: {
      isLifecycleRunning: () => true,
      isDrainRequested: () => false,
      isLaunchFenceActive: () => false,
      beginRequest: vi.fn(),
      endRequest: vi.fn(),
      requestDrain,
    },
    health: {
      read: () => ({
        status: 'ok' as const,
        kernel: { phase: 'running' as const, readyAt: 0 },
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod' as const,
        namespace: 'test-namespace',
        instanceId: 'test-instance',
        pid: 12345,
        uptimeMs: 1,
        active: 0,
        activeJobs: 0,
        liveDiscuss: 0,
        queueDepth: 0,
        inflightRequests: 0,
        textProjectionState: 'idle',
        env: {},
        components: [{ id: 'kb', phase: 'online' as const }],
      }),
    },
    events: {
      bus: {} as never,
      addResponse: vi.fn(),
      removeResponse: vi.fn(),
      createStreamId: () => 'stream-id',
      nowIsoString: () => '2026-04-20T00:00:00.000Z',
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    },
    sessions: {
      start: vi.fn(),
    },
    jobs: {
      scopeCheck: vi.fn(() => ({ valid: [], missing: [], mismatch: [] })),
      abort: vi.fn(),
      waitStream: vi.fn(),
      list: vi.fn(() => []),
      detail: vi.fn(() => null),
    },
    workflows: {
      execute: vi.fn(),
    },
    kb: {
      readSearch: vi.fn(),
      diagnose: vi.fn(),
      readNote: vi.fn(),
      readSource: vi.fn(),
      readCommunity: vi.fn(),
      listStaleCommunities: vi.fn(),
      readCommunitySummaryInput: vi.fn(),
      setCommunitySummary: vi.fn(),
      readWiki: vi.fn(),
      readMemo: vi.fn(),
      readPrinciple: vi.fn(),
      listSources: vi.fn(),
      listWikis: vi.fn(),
      listMemos: vi.fn(),
      listPrinciples: vi.fn(),
      createNote: vi.fn(),
      updateNote: vi.fn(),
      deleteNote: vi.fn(),
      createWiki: vi.fn(),
      rewriteWiki: vi.fn(),
      linkWiki: vi.fn(),
      unlinkWiki: vi.fn(),
      citeWiki: vi.fn(),
      adoptWiki: vi.fn(),
      deleteWiki: vi.fn(),
      wakeUp: vi.fn(),
      createSource: vi.fn(),
      deleteSource: vi.fn(),
      createMemo: vi.fn(),
      deleteMemos: vi.fn(),
      reindex: vi.fn(),
    },
    discuss: {
      seed: vi.fn(),
      start: vi.fn(),
      listSessions: vi.fn(() => [
        {
          sessionId: 'session-1',
          projectRoot: '/project-root',
          topic: 'Parity topic',
          status: 'setup' as const,
          createdAt: '2026-04-20T00:00:00.000Z',
          agentCount: 2,
          authority: 'live' as const,
        },
      ]),
      loadDetail: vi.fn(),
      watch: vi.fn(),
      bid: vi.fn(),
      speech: vi.fn(),
      abort: vi.fn(),
    },
    recoveryQuarantine: {
      clear: vi.fn(async (request) => ({ ...request, disposition: 'advanced' as const })),
    },
    providerHosts: {
      list: vi.fn(),
      inspect: vi.fn(),
      evict: vi.fn(),
    },
    expansion: {
      equipExpansion: vi.fn(),
      unequipExpansion: vi.fn(),
      removeExpansionCatalog: vi.fn(async () => ({ status: 'removed' as const })),
      listExpansion: vi.fn(async () => ({ expansions: [] })),
      readBinding: vi.fn(async () => ({ bound: false })),
    },
  };
}

afterEach(() => {
  capturedComposition.ports = null;
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ipc server', () => {
  it('serves and closes the same IPC surface at compatibility addresses', async () => {
    const ports = createPorts();
    const listener = createIpcServer(ports);
    const socketPath = makeSocketPath();
    const compatibilityPaths = [makeSocketPath(), makeSocketPath()];

    await listenIpcServer(listener, socketPath, compatibilityPaths);
    try {
      for (const address of [socketPath, ...compatibilityPaths]) {
        await expect(requestIpcMethod(address, 'transport.ping')).resolves.toMatchObject({
          status: 'ok',
          instanceId: 'test-instance',
        });
      }
    } finally {
      await closeIpcServer(listener);
    }

    expect([socketPath, ...compatibilityPaths].some(existsSync)).toBe(false);
  });

  it('reports sockets accepted on a published compatibility address in coordinator health', async () => {
    const harness = createHandoffCoresHarness();
    const publishedSocketPath = join(harness.homeDir, 'published-coordinator.sock');
    writeDiscoveryRecord(
      {
        pid: process.pid,
        port: 1,
        socketPath: publishedSocketPath,
        bundleHash: 'published-bundle',
        flavor: 'prod',
        namespace: 'published-compatibility-health',
        startedAt: 1,
        token: 'published-token',
        bootToken: 'published-boot-token',
      },
      { storage: harness.runtime.storage, env: harness.runtime.env, paths: harness.runtime.paths },
    );
    let compatibilitySocket: Socket | null = null;

    try {
      const booted = await harness.bootCore({
        instanceId: 'published-compatibility-health',
        backendNamespace: 'published-compatibility-health',
      });
      compatibilitySocket = await connectRawIpcSocket(publishedSocketPath);

      await expect(
        requestIpcMethod(booted.serverInfo.socketPath, 'transport.health', undefined, {
          auth: { kind: 'boot', token: booted.serverInfo.bootToken },
        }),
      ).resolves.toMatchObject({ resources: { ipcOpenSockets: 2 } });
    } finally {
      compatibilitySocket?.destroy();
      await harness.cleanup();
    }
  });

  it('rolls back every address when a compatibility address has an incumbent', async () => {
    const occupiedPath = makeSocketPath();
    const incumbent = createIpcServer(createPorts());
    const contender = createIpcServer(createPorts());
    const contenderPath = makeSocketPath();
    await listenIpcServer(incumbent, occupiedPath);

    try {
      await expect(listenIpcServer(contender, contenderPath, [occupiedPath])).resolves.toEqual({
        kind: 'incumbent',
        socketPath: occupiedPath,
      });
      expect(existsSync(contenderPath)).toBe(false);
    } finally {
      await closeIpcServer(contender);
      await closeIpcServer(incumbent);
    }
  });

  it('dispatches catalog-backed unary methods over the socket', async () => {
    const ports = createPorts();
    const listener = createIpcServer(ports);
    const socketPath = makeSocketPath();

    await listenIpcServer(listener, socketPath);
    try {
      await expect(
        requestIpcMethod(socketPath, 'discuss.session.list', {}, { auth: { kind: 'boot', token: 'boot-token' } }),
      ).resolves.toEqual({
        sessions: [
          {
            sessionId: 'session-1',
            projectRoot: '/project-root',
            topic: 'Parity topic',
            status: 'setup',
            createdAt: '2026-04-20T00:00:00.000Z',
            agentCount: 2,
            authority: 'live',
          },
        ],
      });
    } finally {
      await closeIpcServer(listener);
    }
  });

  it('drives the production provider-host response adapter and CLI sender through strict IPC schemas', async () => {
    const record = providerHostInventoryRecord();
    const ref: HostRef = record.ref;
    const host = { ownerId: 'coordinator:test-instance', ...record };
    const { ports, administration } = createProductionProviderHostPorts(record);
    const listener = createIpcServer(ports);
    const socketPath = makeSocketPath();
    await listenIpcServer(listener, socketPath);
    try {
      const sender = createProviderHostCommandOperations({
        getClient: async () => ({
          request: (method, params) =>
            requestIpcMethod(socketPath, method, params, { auth: { kind: 'boot', token: 'boot-token' } }),
        }),
      });
      const listed = await sender.list();
      const formatted = formatProviderHostList(listed);
      const token = formatted.split('\n')[1]?.split('\t')[0];
      expect(token).toMatch(/^ph1\./);

      const decodedSelector = parseProviderHostSelector(token, undefined);
      const inspected = await sender.inspect(decodedSelector);
      expect(inspected.host.ref).toEqual(ref);
      expect(formatProviderHostInspect(inspected)).toContain('"truncatedBeforeSeq": 0');
      expect(formatProviderHostInspect(inspected)).toContain('"truncated": true');
      expect(formatProviderHostInspect(inspected)).toContain('"historical"');
      expect(administration.inspectProviderHost).toHaveBeenCalledExactlyOnceWith(ref);

      await expect(sender.inspect(parseProviderHostSelector(undefined, '.'))).resolves.toEqual({ host });
      expect(administration.inspectProviderHost).toHaveBeenLastCalledWith(ref);
      await expect(sender.evict(decodedSelector)).resolves.toEqual({ ownerId: host.ownerId, hostRef: ref });
      expect(administration.evictHost).toHaveBeenCalledExactlyOnceWith(ref);
    } finally {
      await closeIpcServer(listener);
    }
  });

  it('rejects a non-canonical inventory cwd at the production external response sender', async () => {
    const { ports } = createProductionProviderHostPorts(withMalformedInventoryCwd(providerHostInventoryRecord()));
    const providerHosts = ports.providerHosts;
    if (providerHosts === undefined) throw new Error('Production composition did not assemble provider-host ports.');

    await expect(providerHosts.list()).rejects.toThrow(/provider_host_inventory_unavailable/u);
  });

  it('rejects a non-canonical inventory cwd at the real external response receiver', async () => {
    const malformed = withMalformedInventoryCwd(providerHostInventoryRecord());
    const sender = createProviderHostCommandOperations({
      getClient: async () => ({
        request: async <TResult>() => ({ hosts: [{ ownerId: 'coordinator:test-instance', ...malformed }] }) as TResult,
      }),
    });

    await expect(sender.list()).rejects.toThrow(/Work directory must be absolute and normalized/u);
  });

  it('authenticates catalog requests through child principal handles and rejects over-cap/replayed requests', async () => {
    const childPrincipal: Principal = {
      subject: 'operator',
      transport: 'ipc',
      credential: { kind: 'child-principal', id: 'job-a:session-a' },
      binding: { kind: 'unbound' },
      attenuatedCaps: new Set(['jobs:read']),
    };
    const ports: HttpHandlerPorts = {
      ...createPorts(),
      childPrincipals: {
        authenticate: vi.fn((auth, namespace, nowMs) => {
          if (
            namespace === 'test-namespace' &&
            nowMs === 0 &&
            auth.handle === 'handle-a' &&
            auth.jobId === 'job-a' &&
            auth.sessionId === 'session-a'
          ) {
            return childPrincipal;
          }
          return null;
        }),
      },
    };
    const listener = createIpcServer(ports);
    const socketPath = makeSocketPath();

    await listenIpcServer(listener, socketPath);
    try {
      await expect(
        requestIpcMethod(
          socketPath,
          'jobs.list',
          {},
          {
            auth: {
              kind: 'child',
              handle: 'handle-a',
              token: 'nonce-1',
              jobId: 'job-a',
              sessionId: 'session-a',
            },
          },
        ),
      ).resolves.toEqual({ jobs: [] });

      const denied = await requestIpcMethod(
        socketPath,
        'coordinator.listExpansion',
        {},
        {
          auth: {
            kind: 'child',
            handle: 'handle-a',
            token: 'nonce-2',
            jobId: 'job-a',
            sessionId: 'session-a',
          },
        },
      ).catch((error: unknown) => error);

      expect(denied).toBeInstanceOf(IpcRpcError);
      expect(denied).toMatchObject({
        code: 'missing_capability',
        rpcCode: -32603,
        message: 'This nested Coral session cannot perform this command. Ask the top-level Coral session to run it.',
        data: {
          code: 'missing_capability',
          message: 'This nested Coral session cannot perform this command. Ask the top-level Coral session to run it.',
        },
      });

      await expect(
        requestIpcMethod(
          socketPath,
          'jobs.list',
          {},
          {
            auth: {
              kind: 'child',
              handle: 'handle-a',
              token: 'nonce-3',
              jobId: 'job-b',
              sessionId: 'session-a',
            },
          },
        ),
      ).rejects.toThrow('IPC boot token or child principal required');
    } finally {
      await closeIpcServer(listener);
    }
  });

  it('exposes unauthenticated ping plus boot-token-authenticated health and shutdown methods', async () => {
    const ports = createPorts();
    const requestDrain = vi.spyOn(ports.admin, 'requestDrain');
    const listener = createIpcServer(ports);
    const socketPath = makeSocketPath();
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    await listenIpcServer(listener, socketPath);
    try {
      await expect(requestIpcMethod(socketPath, 'transport.ping')).resolves.toEqual({
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        namespace: 'test-namespace',
        instanceId: 'test-instance',
        pid: 12345,
      });
      await expect(
        requestIpcMethod(socketPath, 'transport.health', undefined, { auth: { kind: 'boot', token: 'boot-token' } }),
      ).resolves.toMatchObject({
        status: 'ok',
        instanceId: 'test-instance',
        components: [{ id: 'kb', phase: 'online' }],
      });
      await expect(
        requestIpcMethod(socketPath, 'transport.shutdown', {}, { auth: { kind: 'boot', token: 'boot-token' } }),
      ).resolves.toEqual({
        status: 'draining',
        instanceId: 'test-instance',
      });
      expect(requestDrain).toHaveBeenCalledWith('replaced');
      const messages = warnSpy.mock.calls.map((call) => String(call[0] ?? ''));
      expect(
        messages.some(
          (message) => message.startsWith('audit ') && message.includes('"event":"admin_shutdown_requested"'),
        ),
      ).toBe(true);
      expect(messages.some((message) => message.includes('"transport":"ipc"'))).toBe(true);
    } finally {
      await closeIpcServer(listener);
      warnSpy.mockRestore();
    }
  });

  it('rejects transport.shutdown without the shutdown capability', async () => {
    const ports = createPorts();
    const requestDrain = vi.spyOn(ports.admin, 'requestDrain');
    const listener = createIpcServer(ports);
    const socketPath = makeSocketPath();

    await listenIpcServer(listener, socketPath);
    try {
      await expect(requestIpcMethod(socketPath, 'transport.shutdown', {})).rejects.toThrow('Manual shutdown required');
      expect(requestDrain).not.toHaveBeenCalled();
    } finally {
      await closeIpcServer(listener);
    }
  });

  it('restarts the KB daemon supervisor through boot-token authenticated IPC', async () => {
    const childHealth = {
      enabled: true as const,
      phase: 'online' as const,
      generation: 2,
      pid: 12345,
      startedAt: 10,
      readyAt: 20,
    };
    const ports = createPorts();
    ports.admin.restartKbDaemon = vi.fn(async () => childHealth);
    const listener = createIpcServer(ports);
    const socketPath = makeSocketPath();
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    await listenIpcServer(listener, socketPath);
    try {
      await expect(
        requestIpcMethod(socketPath, 'transport.kb.restart', {}, { auth: { kind: 'boot', token: 'boot-token' } }),
      ).resolves.toEqual({
        status: 'ok',
        instanceId: 'test-instance',
        kbDaemon: childHealth,
      });
      expect(ports.admin.restartKbDaemon).toHaveBeenCalledWith('ipc-admin');
      const messages = warnSpy.mock.calls.map((call) => String(call[0] ?? ''));
      expect(
        messages.some(
          (message) => message.startsWith('audit ') && message.includes('"event":"admin_kb_daemon_restart_requested"'),
        ),
      ).toBe(true);
      expect(messages.some((message) => message.includes('"transport":"ipc"'))).toBe(true);
    } finally {
      await closeIpcServer(listener);
      warnSpy.mockRestore();
    }
  });

  it('rejects transport.kb.restart without the shutdown capability', async () => {
    const ports = createPorts();
    ports.admin.restartKbDaemon = vi.fn(async () => ({
      enabled: true as const,
      phase: 'online' as const,
      generation: 1,
      pid: 12345,
      startedAt: 10,
      readyAt: 20,
    }));
    const listener = createIpcServer(ports);
    const socketPath = makeSocketPath();

    await listenIpcServer(listener, socketPath);
    try {
      await expect(requestIpcMethod(socketPath, 'transport.kb.restart', {})).rejects.toThrow(
        'Manual KB daemon restart requires shutdown capability',
      );
      expect(ports.admin.restartKbDaemon).not.toHaveBeenCalled();
    } finally {
      await closeIpcServer(listener);
    }
  });

  it('returns a JSON-RPC error when transport.kb.restart fails', async () => {
    const ports = createPorts();
    ports.admin.restartKbDaemon = vi.fn(async () => {
      throw new Error('restart failed');
    });
    const listener = createIpcServer(ports);
    const socketPath = makeSocketPath();
    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => undefined);

    await listenIpcServer(listener, socketPath);
    try {
      await expect(
        requestIpcMethod(socketPath, 'transport.kb.restart', {}, { auth: { kind: 'boot', token: 'boot-token' } }),
      ).rejects.toThrow('Internal error');
      expect(ports.admin.restartKbDaemon).toHaveBeenCalledWith('ipc-admin');
      expect(hasLogLine(ports, 'IPC request error (transport.kb.restart): Error: restart failed')).toBe(true);
    } finally {
      await closeIpcServer(listener);
      warnSpy.mockRestore();
    }
  });

  it('rejects IPC connections across addresses at the process-wide socket cap', async () => {
    const ports = createPorts();
    const listener = createIpcServer(ports, {
      firstFrameTimeoutMs: 60_000,
      maxOpenSockets: 1,
      writeDrainTimeoutMs: 10,
    });
    const socketPath = makeSocketPath();
    const compatibilitySocketPath = makeSocketPath();
    let first: Socket | null = null;
    let second: Socket | null = null;

    await listenIpcServer(listener, socketPath, [compatibilitySocketPath]);
    try {
      first = await connectRawIpcSocket(socketPath);
      await waitForCondition(() => listener.sockets.size === 1, 'first IPC socket tracked');
      second = await connectRawIpcSocket(compatibilitySocketPath);
      await waitForCondition(() => hasLogLine(ports, 'IPC connection cap exceeded'), 'IPC connection cap log');

      expect(listener.sockets.size).toBe(1);
      expect(hasLogLine(ports, 'IPC connection cap exceeded')).toBe(true);
    } finally {
      first?.destroy();
      second?.destroy();
      await closeIpcServer(listener);
    }
  });

  it('destroys sockets that exceed the aggregate pending frame budget', async () => {
    const ports = createPorts();
    const listener = createIpcServer(ports, {
      firstFrameTimeoutMs: 60_000,
      maxAggregatePendingFrameBytes: 8,
      writeDrainTimeoutMs: 10,
    });
    const socketPath = makeSocketPath();
    const compatibilitySocketPath = makeSocketPath();
    let first: Socket | null = null;
    let second: Socket | null = null;

    await listenIpcServer(listener, socketPath, [compatibilitySocketPath]);
    try {
      first = await connectRawIpcSocket(socketPath);
      second = await connectRawIpcSocket(compatibilitySocketPath);
      await waitForCondition(() => listener.sockets.size === 2, 'two IPC sockets tracked');

      first.write('aaaaa');
      second.write('bbbbb');
      await waitForCondition(() => listener.sockets.size === 1, 'over-budget IPC socket removed');

      expect(listener.sockets.size).toBe(1);
      expect(hasLogLine(ports, 'IPC pending frame budget exceeded')).toBe(true);
    } finally {
      first?.destroy();
      second?.destroy();
      await closeIpcServer(listener);
    }
  });
});
