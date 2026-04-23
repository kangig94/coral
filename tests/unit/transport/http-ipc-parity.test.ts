import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHttpHandler } from '#src/transport/http/handler.js';
import { closeIpcServer, createIpcServer, listenIpcServer } from '#src/transport/ipc/server.js';
import { requestIpcMethod } from '#src/transport/ipc/client.js';
import type { HttpHandlerPorts } from '#src/transport/http/contracts.js';

const tempDirs: string[] = [];
const httpServers: Server[] = [];

function makeSocketPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-http-ipc-parity-'));
  tempDirs.push(root);
  return join(root, 'coordinator.sock');
}

function createPorts(): HttpHandlerPorts {
  return {
    identity: {
      pluginRoot: '/plugin-root',
      token: 'test-token',
      version: '0.5.2',
      bundleHash: 'test-hash',
      flavor: 'prod',
      namespace: 'test-namespace',
      instanceId: 'test-instance',
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
    health: {
      read: () => ({
        status: 'ok',
        version: '0.5.2',
        bundleHash: 'test-hash',
        flavor: 'prod',
        namespace: 'test-namespace',
        instanceId: 'test-instance',
        uptimeMs: 0,
        active: 0,
        activeJobs: 0,
        liveDiscuss: 0,
        queueDepth: 0,
        inflightRequests: 0,
        env: {},
        subsystems: { kb: 'ok', discuss: 'ok' },
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
      resumeBySessionId: vi.fn(),
      forkBySessionId: vi.fn(),
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
      readMemo: vi.fn(),
      readPrinciple: vi.fn(),
      listSources: vi.fn(),
      listMemos: vi.fn(),
      listPrinciples: vi.fn(),
      createNote: vi.fn(),
      updateNote: vi.fn(),
      deleteNote: vi.fn(),
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
    equipment: {
      registerEquipment: vi.fn(),
      unregisterEquipment: vi.fn(),
      listEquipment: vi.fn(async () => ({ equipment: [] })),
    },
  };
}

async function startHttpServer(ports: HttpHandlerPorts): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    void createHttpHandler(ports)(req, res);
  });
  httpServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address');
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

afterEach(async () => {
  for (const server of httpServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('http/ipc parity', () => {
  it('returns the same coordinator RPC payload through HTTP and IPC after wire normalization', async () => {
    const ports = createPorts();
    const socketPath = makeSocketPath();
    const ipcListener = createIpcServer(ports);
    const { baseUrl } = await startHttpServer(ports);

    await listenIpcServer(ipcListener, socketPath);
    try {
      const httpResponse = await fetch(`${baseUrl}/discuss/sessions`, {
        headers: { 'X-Coral-Backend-Token': ports.identity.token },
      });
      const httpBody = await httpResponse.json();
      const ipcBody = await requestIpcMethod(socketPath, 'discuss.session.list', {});

      expect(httpBody).toEqual(ipcBody);
    } finally {
      await closeIpcServer(ipcListener);
    }
  });
});
