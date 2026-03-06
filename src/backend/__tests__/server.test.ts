import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { textResult } from '../../shared/mcp-utils.js';
import type { BackendServerController } from '../server.js';

let tmpHome = '';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

type ServerModule = typeof import('../server.js');
type BackendInfoModule = typeof import('../backend-info.js');
type BackendLockModule = typeof import('../backend-lock.js');

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function closeHttpServer(server: import('node:http').Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });
}

async function waitForCondition(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

async function loadBackendModules(): Promise<{
  serverModule: ServerModule;
  backendInfo: BackendInfoModule;
  backendLock: BackendLockModule;
}> {
  vi.resetModules();
  const [serverModule, backendInfo, backendLock] = await Promise.all([
    import('../server.js'),
    import('../backend-info.js'),
    import('../backend-lock.js'),
  ]);
  return { serverModule, backendInfo, backendLock };
}

describe('backend server', () => {
  let controller: BackendServerController | null = null;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'coral-backend-server-test-'));
  });

  afterEach(async () => {
    if (controller && controller.getLifecycle() !== 'stopped') {
      try {
        await controller.shutdown('test');
      } catch {
        /* best effort */
      }
    }
    controller = null;
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = '';
  });

  async function startBackendServer(
    overrides: Parameters<ServerModule['createBackendServer']>[0] = {},
  ) {
    const { serverModule, backendInfo, backendLock } = await loadBackendModules();
    controller = serverModule.createBackendServer({
      instanceId: 'backend-instance-1',
      token: 'test-token',
      version: '9.9.9',
      log: () => {},
      ...overrides,
    });
    const started = await controller.start();
    return {
      controller,
      backendInfo,
      backendLock,
      started,
      baseUrl: `http://127.0.0.1:${started.port}`,
      token: started.token,
    };
  }

  it('returns 401 for unauthenticated /health, /tool, and /admin/shutdown', async () => {
    const backend = await startBackendServer();

    const health = await fetch(`${backend.baseUrl}/health`);
    const tool = await fetch(`${backend.baseUrl}/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'codex', args: { op: 'exec' }, context: { projectRoot: '/tmp/project' } }),
    });
    const shutdown = await fetch(`${backend.baseUrl}/admin/shutdown`, { method: 'POST' });

    expect(health.status).toBe(401);
    expect(tool.status).toBe(401);
    expect(shutdown.status).toBe(401);
  });

  it('returns authenticated health metadata', async () => {
    const backend = await startBackendServer();

    const response = await fetch(`${backend.baseUrl}/health`, {
      headers: { 'X-Coral-Backend-Token': backend.started.token },
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      version: '9.9.9',
      instanceId: 'backend-instance-1',
      activeChildren: 0,
      activeSessions: 0,
      inflightRequests: 1,
    });
    expect(typeof body.uptime).toBe('number');
  });

  it('routes authenticated /tool requests through the backend router', async () => {
    const routeToolCallFn = vi.fn(async () => textResult('tool stub', true));
    const backend = await startBackendServer({ routeToolCallFn });

    const response = await fetch(`${backend.baseUrl}/tool`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.started.token,
      },
      body: JSON.stringify({
        name: 'codex',
        args: { op: 'exec', prompt: 'hello' },
        context: { projectRoot: '/tmp/project' },
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual(textResult('tool stub', true));
    expect(routeToolCallFn).toHaveBeenCalledWith(
      'codex',
      { op: 'exec', prompt: 'hello' },
      { projectRoot: '/tmp/project' },
    );
  });

  it('returns 200 from /admin/shutdown and runs the shutdown path', async () => {
    let closeStarted = false;
    const closeBarrier = createDeferred();
    const backend = await startBackendServer({
      closeServerFn: async (server) => {
        closeStarted = true;
        await closeBarrier.promise;
        await closeHttpServer(server);
      },
    });

    const response = await fetch(`${backend.baseUrl}/admin/shutdown`, {
      method: 'POST',
      headers: { 'X-Coral-Backend-Token': backend.started.token },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'shutting_down' });

    await waitForCondition(() => closeStarted);
    expect(backend.controller.getLifecycle()).toBe('draining');

    closeBarrier.resolve();
    await backend.controller.waitForShutdown();

    expect(backend.controller.getLifecycle()).toBe('stopped');
  });

  it('returns 401 when token value is wrong (not just missing)', async () => {
    const backend = await startBackendServer();
    const res = await fetch(`${backend.baseUrl}/health`, {
      headers: { 'X-Coral-Backend-Token': 'definitely-wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 invalid_request for empty JSON body {}', async () => {
    const backend = await startBackendServer();
    const res = await fetch(`${backend.baseUrl}/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Coral-Backend-Token': backend.token },
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  it('returns 400 invalid_json for malformed JSON body', async () => {
    const backend = await startBackendServer();
    const res = await fetch(`${backend.baseUrl}/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Coral-Backend-Token': backend.token },
      body: '{not valid json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('returns 400 invalid_request when context.projectRoot is missing', async () => {
    const backend = await startBackendServer();
    const res = await fetch(`${backend.baseUrl}/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Coral-Backend-Token': backend.token },
      body: JSON.stringify({ name: 'codex', args: { op: 'exec' }, context: {} }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  it('returns 400 invalid_request when context.projectRoot is empty string', async () => {
    const backend = await startBackendServer();
    const res = await fetch(`${backend.baseUrl}/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Coral-Backend-Token': backend.token },
      body: JSON.stringify({ name: 'codex', args: { op: 'exec' }, context: { projectRoot: '' } }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  it('returns 400 invalid_request when context is an array, not an object', async () => {
    const backend = await startBackendServer();
    const res = await fetch(`${backend.baseUrl}/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Coral-Backend-Token': backend.token },
      body: JSON.stringify({ name: 'codex', args: { op: 'exec' }, context: ['/tmp/project'] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  it('returns 400 invalid_request when args is missing', async () => {
    const backend = await startBackendServer();
    const res = await fetch(`${backend.baseUrl}/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Coral-Backend-Token': backend.token },
      body: JSON.stringify({ name: 'codex', context: { projectRoot: '/tmp/p' } }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  it('returns 500 when routeToolCallFn throws synchronously', async () => {
    const routeToolCallFn = vi.fn(() => { throw new Error('boom from router'); });
    const backend = await startBackendServer({ routeToolCallFn });
    const res = await fetch(`${backend.baseUrl}/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Coral-Backend-Token': backend.token },
      body: JSON.stringify({ name: 'codex', args: { op: 'exec' }, context: { projectRoot: '/tmp/p' } }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
  });

  it('returns 404 for an unknown GET route', async () => {
    const backend = await startBackendServer();
    const res = await fetch(`${backend.baseUrl}/unknown-path`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('returns 404 for GET /tool (method not allowed)', async () => {
    const backend = await startBackendServer();
    const res = await fetch(`${backend.baseUrl}/tool`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for POST /health (method not allowed)', async () => {
    const backend = await startBackendServer();
    const res = await fetch(`${backend.baseUrl}/health`, {
      method: 'POST',
      headers: { 'X-Coral-Backend-Token': backend.token },
    });
    expect(res.status).toBe(404);
  });

  it('concurrent shutdown calls both resolve without error', async () => {
    const backend = await startBackendServer();
    await expect(Promise.all([
      backend.controller.shutdown('first'),
      backend.controller.shutdown('second'),
    ])).resolves.not.toThrow();
    expect(backend.controller.getLifecycle()).toBe('stopped');
  });

  it('waitForShutdown resolves immediately on a never-started controller', async () => {
    const { serverModule } = await loadBackendModules();
    const ctrl = serverModule.createBackendServer({
      instanceId: 'pre-start',
      token: 'tok',
      version: '1.0.0',
      log: () => {},
    });
    await expect(ctrl.waitForShutdown()).resolves.toBeUndefined();
    await closeHttpServer(ctrl.server);
  });

  it('throws when start() is called a second time', async () => {
    const backend = await startBackendServer();
    await expect(backend.controller.start()).rejects.toThrow('already started');
  });

  it('returns 503 for POST /tool while the server is draining', async () => {
    const closeBarrier = createDeferred();
    const backend = await startBackendServer({
      closeServerFn: async (server) => {
        await closeBarrier.promise;
        await closeHttpServer(server);
      },
    });

    void fetch(`${backend.baseUrl}/admin/shutdown`, {
      method: 'POST',
      headers: { 'X-Coral-Backend-Token': backend.token },
    });

    await waitForCondition(() => backend.controller.getLifecycle() === 'draining');

    const toolRes = await fetch(`${backend.baseUrl}/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Coral-Backend-Token': backend.token },
      body: JSON.stringify({ name: 'codex', args: {}, context: { projectRoot: '/tmp/p' } }),
    });
    expect(toolRes.status).toBe(503);

    closeBarrier.resolve();
    await backend.controller.waitForShutdown();
  });

  it('returns 503 while draining and keeps owner files until close completes', async () => {
    let closeStarted = false;
    const closeBarrier = createDeferred();
    const backend = await startBackendServer({
      closeServerFn: async (server) => {
        closeStarted = true;
        await closeBarrier.promise;
        await closeHttpServer(server);
      },
    });

    expect(existsSync(backend.backendInfo.BACKEND_INFO_PATH)).toBe(true);
    expect(existsSync(backend.backendLock.BACKEND_LOCK_PATH)).toBe(true);

    const shutdownResponse = await fetch(`${backend.baseUrl}/admin/shutdown`, {
      method: 'POST',
      headers: { 'X-Coral-Backend-Token': backend.started.token },
    });
    expect(shutdownResponse.status).toBe(200);

    await waitForCondition(() => closeStarted);

    const drainingResponse = await fetch(`${backend.baseUrl}/health`, {
      headers: { 'X-Coral-Backend-Token': backend.started.token },
    });

    expect(drainingResponse.status).toBe(503);
    expect(await drainingResponse.json()).toEqual({ error: 'backend_shutting_down' });
    expect(existsSync(backend.backendInfo.BACKEND_INFO_PATH)).toBe(true);
    expect(existsSync(backend.backendLock.BACKEND_LOCK_PATH)).toBe(true);

    closeBarrier.resolve();
    await backend.controller.waitForShutdown();

    expect(existsSync(backend.backendInfo.BACKEND_INFO_PATH)).toBe(false);
    expect(existsSync(backend.backendLock.BACKEND_LOCK_PATH)).toBe(false);
  });
});
