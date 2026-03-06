import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WaitStreamEvent } from '../../types.js';
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

type FakeExecutionService = {
  start: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  fork: ReturnType<typeof vi.fn>;
  coralDispatch: ReturnType<typeof vi.fn>;
  executeWorkflow: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  waitStream: ReturnType<typeof vi.fn>;
};

function createFakeExecutionService(overrides: Partial<FakeExecutionService> = {}): FakeExecutionService {
  return {
    start: vi.fn(),
    resume: vi.fn(),
    fork: vi.fn(),
    coralDispatch: vi.fn(),
    executeWorkflow: vi.fn(async () => ({ status: 'running', job: 'workflow-job', session: 'workflow-session' })),
    list: vi.fn(() => ({ sessions: [] })),
    abort: vi.fn((jobIds: string[]) => ({ aborted: jobIds, notFound: [] })),
    waitStream: vi.fn(async function* (): AsyncGenerator<WaitStreamEvent> {
      yield {
        type: 'progress',
        jobId: 'job-1',
        sessionId: 'session-1',
        eventId: 7,
        message: 'working',
      };
      yield {
        type: 'terminal',
        completedJobId: 'job-1',
        sessionId: 'session-1',
        remainingJobIds: [],
        result: { text: 'done' },
      };
    }),
    ...overrides,
  };
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

async function loadExecutionModules(): Promise<{
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

describe('execution backend server', () => {
  let controller: BackendServerController | null = null;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'coral-execution-backend-test-'));
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
    const { serverModule, backendInfo, backendLock } = await loadExecutionModules();
    controller = serverModule.createBackendServer({
      instanceId: 'execution-backend-instance-1',
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

  it('returns 200 from /health with execution metadata', async () => {
    const backend = await startBackendServer();

    const response = await fetch(`${backend.baseUrl}/health`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      version: '9.9.9',
      instanceId: 'execution-backend-instance-1',
      activeChildren: 0,
      activeJobs: 0,
      inflightRequests: 1,
    });
    expect(typeof body.uptime).toBe('number');
  });

  it('returns 200 from /tools with provider and built-in descriptors', async () => {
    const backend = await startBackendServer();

    const response = await fetch(`${backend.baseUrl}/tools`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
    });
    const body = await response.json() as Array<Record<string, unknown>>;

    expect(response.status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((tool) => tool.name === 'codex')).toBe(true);
    expect(body.some((tool) => tool.name === 'claude')).toBe(true);
    expect(body.some((tool) => tool.name === 'wait')).toBe(true);
    expect(body.some((tool) => tool.name === 'abort')).toBe(true);
    expect(body.some((tool) => tool.name === 'workflow')).toBe(true);
  });

  it('returns 404 for unknown /tool requests', async () => {
    const backend = await startBackendServer();

    const response = await fetch(`${backend.baseUrl}/tool`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        name: 'missing-provider',
        args: { op: 'exec', prompt: 'hello' },
        context: { projectRoot: '/tmp/project' },
      }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'not_found',
      message: 'Unknown tool: missing-provider',
    });
  });

  it('returns 400 use_sse for wait tool calls sent to /tool', async () => {
    const backend = await startBackendServer();

    const response = await fetch(`${backend.baseUrl}/tool`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        name: 'wait',
        args: { jobs: ['job-1'] },
        context: { projectRoot: '/tmp/project' },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'use_sse',
      message: 'Use POST /wait/stream for wait operations',
    });
  });

  it('returns 200 for abort tool calls', async () => {
    const backend = await startBackendServer();

    const response = await fetch(`${backend.baseUrl}/tool`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        name: 'abort',
        args: { jobs: ['job-1'] },
        context: { projectRoot: '/tmp/project' },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ aborted: [], notFound: ['job-1'] });
  });

  it('routes workflow tool calls through handleWorkflow', async () => {
    const fakeService = createFakeExecutionService();
    const backend = await startBackendServer({
      createExecutionService: () => fakeService as never,
    });

    const response = await fetch(`${backend.baseUrl}/tool`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        name: 'workflow',
        args: { expression: 'architect', prompt: 'hello' },
        context: { projectRoot: '/tmp/project' },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'running',
      job: 'workflow-job',
      session: 'workflow-session',
    });
    expect(fakeService.executeWorkflow).toHaveBeenCalledTimes(1);
  });

  it('streams SSE wait events and closes after terminal completion', async () => {
    const fakeService = createFakeExecutionService();
    const backend = await startBackendServer({
      createExecutionService: () => fakeService as never,
    });

    const response = await fetch(`${backend.baseUrl}/wait/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        jobIds: ['job-1'],
        timeoutSeconds: 1,
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('connection')).toBe('keep-alive');
    expect(body).toContain('event: progress');
    expect(body).toContain('event: terminal');
    expect(body).toContain('"message":"working"');
    expect(body).toContain('"text":"done"');

    const firstIdLine = body.split('\n').find((line) => line.startsWith('id: '));
    expect(firstIdLine).toBeTruthy();
    const encodedCursor = firstIdLine?.slice(4) ?? '';
    expect(JSON.parse(Buffer.from(encodedCursor, 'base64url').toString('utf-8'))).toEqual({
      jobs: { 'job-1': 7 },
    });
    expect(fakeService.waitStream).toHaveBeenCalledWith({
      jobIds: ['job-1'],
      timeoutSeconds: 1,
      cursor: { jobs: {} },
    });
  });

  it('returns 200 from /admin/shutdown and transitions to draining', async () => {
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
      headers: { 'X-Coral-Backend-Token': backend.token },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'shutting_down' });

    await waitForCondition(() => closeStarted);
    expect(backend.controller.getLifecycle()).toBe('draining');
    expect(existsSync(backend.backendInfo.BACKEND_INFO_PATH)).toBe(true);
    expect(existsSync(backend.backendLock.BACKEND_LOCK_PATH)).toBe(true);

    closeBarrier.resolve();
    await backend.controller.waitForShutdown();

    expect(backend.controller.getLifecycle()).toBe('stopped');
    expect(existsSync(backend.backendInfo.BACKEND_INFO_PATH)).toBe(false);
    expect(existsSync(backend.backendLock.BACKEND_LOCK_PATH)).toBe(false);
  });

  it('returns 401 for unauthorized requests', async () => {
    const backend = await startBackendServer();

    const response = await fetch(`${backend.baseUrl}/health`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });
});
