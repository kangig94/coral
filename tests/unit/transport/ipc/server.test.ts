import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeIpcServer, createIpcServer, listenIpcServer } from '#src/transport/ipc/server.js';
import { requestIpcMethod } from '#src/transport/ipc/client.js';
import type { HttpHandlerPorts } from '#src/transport/server-ports.js';

const tempDirs: string[] = [];

function makeSocketPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-ipc-server-test-'));
  tempDirs.push(root);
  return join(root, 'coordinator.sock');
}

function createPorts(): HttpHandlerPorts {
  const requestDrain = vi.fn();

  return {
    identity: {
      pluginRoot: '/plugin-root',
      token: 'unused-for-ipc',
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
        env: {},
        subsystems: [{ id: 'kb', phase: 'online' as const }],
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
  for (const root of tempDirs.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ipc server', () => {
  it('dispatches catalog-backed unary methods over the socket', async () => {
    const ports = createPorts();
    const listener = createIpcServer(ports);
    const socketPath = makeSocketPath();

    await listenIpcServer(listener, socketPath);
    try {
      await expect(requestIpcMethod(socketPath, 'discuss.session.list', {})).resolves.toEqual({
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

  it('exposes transport-local health and shutdown methods outside rpcCatalog', async () => {
    const ports = createPorts();
    const requestDrain = vi.spyOn(ports.admin, 'requestDrain');
    const listener = createIpcServer(ports);
    const socketPath = makeSocketPath();

    await listenIpcServer(listener, socketPath);
    try {
      await expect(requestIpcMethod(socketPath, 'transport.health')).resolves.toMatchObject({
        status: 'ok',
        instanceId: 'test-instance',
      });
      await expect(requestIpcMethod(socketPath, 'transport.shutdown')).resolves.toEqual({
        status: 'draining',
        instanceId: 'test-instance',
      });
      expect(requestDrain).toHaveBeenCalledWith('replaced');
    } finally {
      await closeIpcServer(listener);
    }
  });
});
