import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CoralSetupError, serializeCoralSetupError, type SerializedCoralSetupError } from '../../runtime/errors.js';
import { buildTransportErrorResponse } from '../error-response.js';
import type { HttpHandlerPorts } from '../http/contracts.js';
import { createHttpHandler, sendJson } from '../http/handler.js';
import { requestIpcMethod } from '../ipc/client.js';
import { closeIpcServer, createIpcServer, listenIpcServer } from '../ipc/server.js';

const tempDirs: string[] = [];
const httpServers: Server[] = [];

function makeSocketPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-setup-error-parity-'));
  tempDirs.push(root);
  return join(root, 'coordinator.sock');
}

function equipmentInstallLockContended(): SerializedCoralSetupError {
  return {
    code: 'equipment_install_lock_contended',
    userMessage: 'Another /equip is in progress for needle.',
    remediation: 'Wait for the in-flight install to complete or remove the stale lock file.',
    context: { name: 'needle' },
  };
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
      listSessions: vi.fn(() => []),
      loadDetail: vi.fn(),
      watch: vi.fn(),
      bid: vi.fn(),
      speech: vi.fn(),
      abort: vi.fn(),
    },
    equipment: {
      registerEquipment: vi.fn(async () => {
        throw new CoralSetupError(equipmentInstallLockContended());
      }),
      unregisterEquipment: vi.fn(),
      listEquipment: vi.fn(async () => ({ equipment: [] })),
    },
  };
}

async function startHttpServer(ports: HttpHandlerPorts): Promise<{ baseUrl: string }> {
  const handler = createHttpHandler(ports);
  const server = createServer((req, res) => {
    void handler(req, res).catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 500, buildTransportErrorResponse(error).body);
        return;
      }
      res.destroy();
    });
  });

  httpServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address');
  }

  return {
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

async function requestIpcErrorPayload(socketPath: string): Promise<SerializedCoralSetupError> {
  try {
    await requestIpcMethod(socketPath, 'coordinator.registerEquipment', { name: 'needle' });
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Another /equip is in progress for needle.');
    const structured = serializeCoralSetupError(error instanceof Error ? error.cause : null);
    expect(structured).not.toBeNull();
    return structured as SerializedCoralSetupError;
  }

  throw new Error('Expected IPC request to fail');
}

async function requestHttpErrorPayload(baseUrl: string, token: string): Promise<SerializedCoralSetupError> {
  const response = await fetch(`${baseUrl}/coordinator/equipment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Coral-Backend-Token': token,
    },
    body: JSON.stringify({ name: 'needle' }),
  });

  expect(response.status).toBe(500);
  const body = await response.json();
  expect(body).toMatchObject({
    code: 'equipment_install_lock_contended',
    userMessage: 'Another /equip is in progress for needle.',
    remediation: 'Wait for the in-flight install to complete or remove the stale lock file.',
    context: { name: 'needle' },
  });
  const structured = serializeCoralSetupError(body);
  expect(structured).not.toBeNull();
  return structured as SerializedCoralSetupError;
}

describe('coral setup error parity', () => {
  it('surfaces the same structured CoralSetupError payload through IPC and HTTP', async () => {
    const ports = createPorts();
    const expected = equipmentInstallLockContended();
    const socketPath = makeSocketPath();
    const ipcListener = createIpcServer(ports);
    const { baseUrl } = await startHttpServer(ports);

    await listenIpcServer(ipcListener, socketPath);
    try {
      const ipcPayload = await requestIpcErrorPayload(socketPath);
      const httpPayload = await requestHttpErrorPayload(baseUrl, ports.identity.token);

      expect(ipcPayload).toEqual(expected);
      expect(httpPayload).toEqual(expected);
    } finally {
      await closeIpcServer(ipcListener);
    }
  });
});
