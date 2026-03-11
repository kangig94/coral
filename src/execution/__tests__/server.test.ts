import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage as ClientIncomingMessage } from 'node:http';
import { basename, join } from 'node:path';
import type { WaitStreamEvent } from '../../types.js';

import { JOBS_DIR, ProgressStore, jobResultPath } from '../progress-store.js';
import { SessionManager } from '../session-manager.js';
import type { BackendServerController } from '../server.js';

const mockState = vi.hoisted(() => ({
  tmpHome: '',
  tmpRoot: `${process.env.TMPDIR || '/tmp'}/coral-execution-backend-test-tmp`,
}));

const createdJobIds = new Set<string>();

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => mockState.tmpHome,
    tmpdir: () => mockState.tmpRoot,
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
        resultPath: jobResultPath('job-1'),
        result: { content: 'done' },
      };
    }),
    ...overrides,
  };
}

function createFakeIdleTimer() {
  let inflight = 0;
  return {
    beginRequest: vi.fn(() => {
      inflight += 1;
    }),
    endRequest: vi.fn(() => {
      if (inflight > 0) inflight -= 1;
    }),
    get inflightRequests() {
      return inflight;
    },
    startWatching: vi.fn(),
    stopWatching: vi.fn(),
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

async function openHttpStream(url: string, headers: Record<string, string>): Promise<{
  response: ClientIncomingMessage;
  waitForText: (check: (text: string) => boolean, timeoutMs?: number) => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers });
    req.once('error', reject);
    req.once('response', (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
      });

      const waitForText = (check: (current: string) => boolean, timeoutMs = 2_000): Promise<string> => {
        if (check(text)) return Promise.resolve(text);

        return new Promise<string>((resolveText, rejectText) => {
          const timeout = setTimeout(() => {
            cleanup();
            rejectText(new Error('Timed out reading stream'));
          }, timeoutMs);

          const onData = () => {
            if (!check(text)) return;
            cleanup();
            resolveText(text);
          };
          const onEnd = () => {
            cleanup();
            rejectText(new Error('Stream ended before expected data arrived'));
          };
          const onError = (error: Error) => {
            cleanup();
            rejectText(error);
          };
          const cleanup = () => {
            clearTimeout(timeout);
            response.off('data', onData);
            response.off('end', onEnd);
            response.off('error', onError);
          };

          response.on('data', onData);
          response.once('end', onEnd);
          response.once('error', onError);
        });
      };

      resolve({
        response,
        waitForText,
        close: () => {
          req.destroy();
          response.destroy();
        },
      });
    });
    req.end();
  });
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
    rmSync(mockState.tmpRoot, { recursive: true, force: true });
    mkdirSync(mockState.tmpRoot, { recursive: true });
    mockState.tmpHome = mkdtempSync(join(mockState.tmpRoot, 'home-'));
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
    for (const jobId of createdJobIds) {
      rmSync(join(JOBS_DIR, jobId), { recursive: true, force: true });
    }
    createdJobIds.clear();
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(mockState.tmpRoot, { recursive: true, force: true });
    mockState.tmpHome = '';
  });

  async function startBackendServer(
    overrides: Parameters<ServerModule['createBackendServer']>[0] = {},
  ) {
    const { serverModule, backendInfo, backendLock } = await loadExecutionModules();
    controller = serverModule.createBackendServer({
      instanceId: 'execution-backend-instance-1',
      token: 'test-token',
      version: '9.9.9',
      bundleHash: 'testhash1234',
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

  function createProjectRoot(name: string): string {
    const projectRoot = join(mockState.tmpHome, name);
    mkdirSync(projectRoot, { recursive: true });
    return projectRoot;
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
      bundleHash: 'testhash1234',
      instanceId: 'execution-backend-instance-1',
      activeChildren: 0,
      activeJobs: 0,
      inflightRequests: 1,
      queueDepth: 0,
    });
    expect(typeof body.uptimeMs).toBe('number');
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
    expect(body.some((tool) => tool.name === 'discuss_seed')).toBe(true);
    expect(body.some((tool) => tool.name === 'discuss_start')).toBe(true);
    expect(body.some((tool) => tool.name === 'discuss_abort')).toBe(true);
    expect(body.some((tool) => tool.name === 'discuss_watch')).toBe(true);
    expect(body.some((tool) => tool.name === 'discuss_participate')).toBe(true);
  });

  it('recovers discuss-only project roots from the durable root registry before idle watching starts', async () => {
    const fakeIdleTimer = createFakeIdleTimer();
    const projectRoot = createProjectRoot('discuss-only-project');
    mkdirSync(join(mockState.tmpHome, '.claude', 'coral'), { recursive: true });
    writeFileSync(
      join(mockState.tmpHome, '.claude', 'coral', 'discuss-project-roots.json'),
      JSON.stringify({
        updatedAt: '2026-03-11T00:00:00.000Z',
        projectRoots: [projectRoot],
      }, null, 2),
      'utf8',
    );

    const recoverPersistedSessions = vi.fn().mockResolvedValue(undefined);
    const discussRegistry = {
      getOrCreate: vi.fn(() => ({ recoverPersistedSessions })),
      get: vi.fn(() => undefined),
      listLiveSessions: vi.fn(() => []),
      hasLiveSessions: vi.fn(() => false),
    };

    await startBackendServer({
      createIdleTimer: () => fakeIdleTimer as never,
      discussRegistry: discussRegistry as never,
    });

    expect(discussRegistry.getOrCreate).toHaveBeenCalledTimes(2);
    const getOrCreateCalls = discussRegistry.getOrCreate.mock.calls as Array<unknown[]>;
    expect(getOrCreateCalls.every((call) => call[0] === projectRoot)).toBe(true);
    expect(recoverPersistedSessions).toHaveBeenCalledTimes(2);
    expect(recoverPersistedSessions).toHaveBeenCalledWith({
      projectRoot,
      pluginRoot: expect.any(String),
    });
    expect(fakeIdleTimer.startWatching).toHaveBeenCalledTimes(1);
    const finalRecoveryOrder = recoverPersistedSessions.mock.invocationCallOrder.at(-1);
    const idleWatchOrder = fakeIdleTimer.startWatching.mock.invocationCallOrder.at(0);
    expect(finalRecoveryOrder).toBeDefined();
    expect(idleWatchOrder).toBeDefined();
    expect(finalRecoveryOrder ?? Number.POSITIVE_INFINITY).toBeLessThan(
      idleWatchOrder ?? Number.POSITIVE_INFINITY,
    );
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

  it('returns 403 for abort tool calls that include cross-project jobs', async () => {
    const fakeService = createFakeExecutionService();
    const progressStore = new ProgressStore();
    createdJobIds.add('job-1');
    createdJobIds.add('job-foreign');
    progressStore.initJob('job-1', 'session-1', 'codex', '/tmp/project');
    progressStore.initJob('job-foreign', 'session-foreign', 'codex', '/tmp/other-project');

    const backend = await startBackendServer({
      createExecutionService: () => fakeService as never,
      progressStore,
    });

    await fetch(`${backend.baseUrl}/tool`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        name: 'codex',
        args: { op: 'list' },
        context: { projectRoot: '/tmp/project' },
      }),
    });

    const response = await fetch(`${backend.baseUrl}/tool`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        name: 'abort',
        args: { jobs: ['job-1', 'job-foreign'] },
        context: { projectRoot: '/tmp/project' },
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'scope_mismatch',
      jobs: ['job-foreign'],
    });
    expect(fakeService.abort).not.toHaveBeenCalled();
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
        args: { expression: 'architect', init_prompt: 'hello' },
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

  it('routes bypass_exec with bypassPermissions true', async () => {
    const fakeService = createFakeExecutionService({
      start: vi.fn(async () => ({ status: 'running', job: 'bypass-job', session: 'bypass-session' })),
    });
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
        name: 'codex',
        args: { op: 'bypass_exec', prompt: 'do something' },
        context: { projectRoot: '/tmp/project' },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'running',
      job: 'bypass-job',
      session: 'bypass-session',
    });
    expect(fakeService.start).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ bypassPermissions: true }),
      expect.any(Object),
    );
  });

  it('routes exec with bypassPermissions false by default', async () => {
    const fakeService = createFakeExecutionService({
      start: vi.fn(async () => ({ status: 'running', job: 'exec-job', session: 'exec-session' })),
    });
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
        name: 'codex',
        args: { op: 'exec', prompt: 'do something' },
        context: { projectRoot: '/tmp/project' },
      }),
    });

    expect(response.status).toBe(200);
    expect(fakeService.start).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ bypassPermissions: false }),
      expect.any(Object),
    );
  });

  it('streams SSE wait events and closes after terminal completion for found/missing mixes', async () => {
    const fakeService = createFakeExecutionService();
    const progressStore = new ProgressStore();
    createdJobIds.add('job-1');
    progressStore.initJob('job-1', 'session-1', 'codex', '/tmp/project');
    const backend = await startBackendServer({
      createExecutionService: () => fakeService as never,
      progressStore,
    });

    const response = await fetch(`${backend.baseUrl}/wait/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        jobIds: ['job-1', 'missing-job'],
        timeoutSeconds: 1,
        projectRoot: '/tmp/project',
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
    expect(body).toContain('"content":"done"');

    const firstIdLine = body.split('\n').find((line) => line.startsWith('id: '));
    expect(firstIdLine).toBeTruthy();
    const encodedCursor = firstIdLine?.slice(4) ?? '';
    expect(JSON.parse(Buffer.from(encodedCursor, 'base64url').toString('utf-8'))).toEqual({
      jobs: { 'job-1': 7 },
    });
    expect(fakeService.waitStream).toHaveBeenCalledWith({
      jobIds: ['job-1', 'missing-job'],
      timeoutSeconds: 1,
      cursor: { jobs: {} },
      projectRoot: '/tmp/project',
    });
  });

  it('streams passive dashboard SSE events and applies the optional job filter', async () => {
    const fakeIdleTimer = createFakeIdleTimer();
    const backend = await startBackendServer({
      createIdleTimer: () => fakeIdleTimer as never,
    });
    const { eventBus } = await import('../event-bus.js');

    const stream = await openHttpStream(`${backend.baseUrl}/events/stream?filter=job:job-1`, {
      'X-Coral-Backend-Token': backend.token,
    });

    expect(stream.response.statusCode).toBe(200);
    expect(String(stream.response.headers['content-type'])).toContain('text/event-stream');
    expect(String(stream.response.headers['cache-control'])).toBe('no-cache');
    expect(String(stream.response.headers.connection)).toBe('keep-alive');

    try {
      const readyChunk = await stream.waitForText((text) => text.includes('event: ready'));
      expect(readyChunk).toContain('event: ready');
      expect(readyChunk).toContain('"streamId":"');

      eventBus.emit('job:created', {
        jobId: 'job-1',
        sessionId: 'session-1',
        provider: 'codex',
        projectRoot: '/tmp/project',
      });
      eventBus.emit('job:created', {
        jobId: 'job-2',
        sessionId: 'session-2',
        provider: 'codex',
        projectRoot: '/tmp/project',
      });
      eventBus.emit('session:updated', {
        sessionId: 'session-1',
        shardHash: 'abc123',
        version: 2,
        projectRoot: '/tmp/project',
      });

      const eventChunk = await stream.waitForText(
        (text) => text.includes('event: job:created') && text.includes('event: session:updated'),
      );

      expect(eventChunk).toContain('"jobId":"job-1"');
      expect(eventChunk).not.toContain('"jobId":"job-2"');
      expect(eventChunk).toContain('"sessionId":"session-1"');
      expect(fakeIdleTimer.beginRequest).not.toHaveBeenCalled();
      expect(fakeIdleTimer.endRequest).not.toHaveBeenCalled();
    } finally {
      stream.close();
    }
  });

  it('lists jobs and returns replayed job detail', async () => {
    const progressStore = new ProgressStore();
    createdJobIds.add('job-1');
    createdJobIds.add('job-2');
    progressStore.initJob('job-1', 'session-1', 'codex', '/tmp/project');
    progressStore.appendProgress('job-1', 'session-1', 'working');
    progressStore.appendTerminal('job-1', 'session-1', { content: 'done' }, 'completed');
    progressStore.initJob('job-2', 'session-2', 'claude', '/tmp/project');

    const backend = await startBackendServer({
      progressStore,
      recoverOrphanedJobsFn: () => {},
    });

    const jobsResponse = await fetch(`${backend.baseUrl}/api/jobs`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
    });
    const jobsBody = await jobsResponse.json() as {
      jobs: Array<{ jobId: string; status: Record<string, unknown> }>;
    };

    expect(jobsResponse.status).toBe(200);
    expect(jobsBody.jobs).toEqual(expect.arrayContaining([
      {
        jobId: 'job-1',
        status: expect.objectContaining({
          jobId: 'job-1',
          sessionId: 'session-1',
          provider: 'codex',
          phase: 'completed',
        }),
      },
      {
        jobId: 'job-2',
        status: expect.objectContaining({
          jobId: 'job-2',
          sessionId: 'session-2',
          provider: 'claude',
          phase: 'launching',
        }),
      },
    ]));

    const detailResponse = await fetch(`${backend.baseUrl}/api/jobs/job-1`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
    });
    const detailBody = await detailResponse.json() as {
      status: Record<string, unknown>;
      events: Array<Record<string, unknown>>;
    };

    expect(detailResponse.status).toBe(200);
    expect(detailBody.status).toMatchObject({
      jobId: 'job-1',
      phase: 'completed',
      result: { content: 'done' },
    });
    expect(detailBody.events).toHaveLength(2);
    expect(detailBody.events[0]).toMatchObject({
      eventId: 1,
      type: 'progress',
    });
    expect(String(detailBody.events[0].message)).toContain('working');
    expect(detailBody.events[1]).toMatchObject({
      eventId: 2,
      type: 'terminal',
      result: { content: 'done' },
    });

    const missingResponse = await fetch(`${backend.baseUrl}/api/jobs/missing-job`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
    });

    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({ error: 'job_not_found' });
  });

  describe('/api/jobs phase filter', () => {
    it('filters collection responses by phase and preserves job detail lookups', async () => {
      const fakeService = createFakeExecutionService();
      const progressStore = new ProgressStore();
      createdJobIds.add('job-running');
      createdJobIds.add('job-queued');
      createdJobIds.add('job-completed');

      progressStore.initJob('job-running', 'session-running', 'codex', '/tmp/project', undefined, 'running');
      progressStore.initJob('job-queued', 'session-queued', 'claude', '/tmp/project', undefined, 'queued');
      progressStore.initJob('job-completed', 'session-completed', 'codex', '/tmp/project');
      progressStore.appendTerminal('job-completed', 'session-completed', { content: 'done' }, 'completed');

      const backend = await startBackendServer({
        createExecutionService: () => fakeService as never,
        progressStore,
        recoverOrphanedJobsFn: () => {},
      });

      const allResponse = await fetch(`${backend.baseUrl}/api/jobs`, {
        headers: { 'X-Coral-Backend-Token': backend.token },
      });
      const allBody = await allResponse.json() as {
        jobs: Array<{ jobId: string; status: { phase: string } }>;
      };

      expect(allResponse.status).toBe(200);
      expect(allBody.jobs.map((job) => job.jobId).sort()).toEqual([
        'job-completed',
        'job-queued',
        'job-running',
      ]);

      const runningResponse = await fetch(`${backend.baseUrl}/api/jobs?phase=running`, {
        headers: { 'X-Coral-Backend-Token': backend.token },
      });
      const runningBody = await runningResponse.json() as {
        jobs: Array<{ jobId: string; status: { phase: string } }>;
      };

      expect(runningResponse.status).toBe(200);
      expect(runningBody.jobs).toEqual([
        {
          jobId: 'job-running',
          status: expect.objectContaining({
            jobId: 'job-running',
            phase: 'running',
          }),
        },
      ]);

      const queuedResponse = await fetch(`${backend.baseUrl}/api/jobs?phase=queued`, {
        headers: { 'X-Coral-Backend-Token': backend.token },
      });
      const queuedBody = await queuedResponse.json() as {
        jobs: Array<{ jobId: string; status: { phase: string } }>;
      };

      expect(queuedResponse.status).toBe(200);
      expect(queuedBody.jobs).toEqual([
        {
          jobId: 'job-queued',
          status: expect.objectContaining({
            jobId: 'job-queued',
            phase: 'queued',
          }),
        },
      ]);

      const detailResponse = await fetch(`${backend.baseUrl}/api/jobs/job-completed`, {
        headers: { 'X-Coral-Backend-Token': backend.token },
      });
      const detailBody = await detailResponse.json() as {
        status: Record<string, unknown>;
        events: Array<Record<string, unknown>>;
      };

      expect(detailResponse.status).toBe(200);
      expect(detailBody.status).toMatchObject({
        jobId: 'job-completed',
        phase: 'completed',
        result: { content: 'done' },
      });
      expect(detailBody.events).toEqual([
        expect.objectContaining({
          eventId: 1,
          type: 'terminal',
          result: { content: 'done' },
        }),
      ]);
    });
  });

  it('lists persisted sessions by shard and skips corrupt entries', async () => {
    const projectRoot = createProjectRoot('session-project');
    const session = new SessionManager(projectRoot).allocate('codex', 'alpha', 'gpt-5', projectRoot);
    const [shardDir] = SessionManager.listShards();
    writeFileSync(join(shardDir, 'corrupt.json'), '{not-json', 'utf-8');

    const backend = await startBackendServer();
    const response = await fetch(`${backend.baseUrl}/api/sessions`, {
      headers: { 'X-Coral-Backend-Token': backend.token },
    });
    const body = await response.json() as {
      sessions: Array<{ shardHash: string; sessions: Array<Record<string, unknown>> }>;
    };

    expect(response.status).toBe(200);
    expect(body.sessions).toEqual([
      {
        shardHash: basename(shardDir),
        sessions: [
          expect.objectContaining({
            sessionId: session.sessionId,
            provider: 'codex',
            state: 'pending',
            version: 1,
          }),
        ],
      },
    ]);
  });

  it('returns 400 when /wait/stream omits or empties projectRoot', async () => {
    const backend = await startBackendServer();

    const missingResponse = await fetch(`${backend.baseUrl}/wait/stream`, {
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

    const emptyResponse = await fetch(`${backend.baseUrl}/wait/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        jobIds: ['job-1'],
        timeoutSeconds: 1,
        projectRoot: '',
      }),
    });

    expect(missingResponse.status).toBe(400);
    expect(await missingResponse.json()).toEqual({ error: 'invalid_request' });
    expect(emptyResponse.status).toBe(400);
    expect(await emptyResponse.json()).toEqual({ error: 'invalid_request' });
  });

  it('returns 403 before streaming when /wait/stream includes cross-project jobs', async () => {
    const fakeService = createFakeExecutionService();
    const progressStore = new ProgressStore();
    createdJobIds.add('job-foreign');
    progressStore.initJob('job-foreign', 'session-foreign', 'codex', '/tmp/other-project');

    const backend = await startBackendServer({
      createExecutionService: () => fakeService as never,
      progressStore,
    });

    const response = await fetch(`${backend.baseUrl}/wait/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        jobIds: ['job-foreign'],
        timeoutSeconds: 1,
        projectRoot: '/tmp/project',
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'scope_mismatch' });
    expect(fakeService.waitStream).not.toHaveBeenCalled();
  });

  it('returns 404 when /wait/stream receives only missing jobs', async () => {
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
        jobIds: ['missing-job'],
        timeoutSeconds: 1,
        projectRoot: '/tmp/project',
      }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'jobs_not_found' });
    expect(fakeService.waitStream).not.toHaveBeenCalled();
  });

  it('clears orphaned session claims across shards when the job dir is missing', async () => {
    const projectA = createProjectRoot('project-a');
    const projectB = createProjectRoot('project-b');
    const sessionA = new SessionManager(projectA).allocate('codex', 'alpha', 'gpt-5', projectA);
    const sessionB = new SessionManager(projectB).allocate('codex', 'beta', 'gpt-5', projectB);

    new SessionManager(projectA).claimForJobSync(sessionA.sessionId, 'missing-job-a');
    new SessionManager(projectB).claimForJobSync(sessionB.sessionId, 'missing-job-b');

    await startBackendServer();

    expect(new SessionManager(projectA).get('codex', sessionA.sessionId)).toMatchObject({
      sessionId: sessionA.sessionId,
      lastJobId: 'missing-job-a',
    });
    expect(new SessionManager(projectA).get('codex', sessionA.sessionId)?.activeJobId).toBeUndefined();

    expect(new SessionManager(projectB).get('codex', sessionB.sessionId)).toMatchObject({
      sessionId: sessionB.sessionId,
      lastJobId: 'missing-job-b',
    });
    expect(new SessionManager(projectB).get('codex', sessionB.sessionId)?.activeJobId).toBeUndefined();
  });

  it('leaves active session claims in place when the referenced job dir exists', async () => {
    const progressStore = new ProgressStore();
    const projectRoot = createProjectRoot('project-existing-job');
    const session = new SessionManager(projectRoot).allocate('codex', 'alpha', 'gpt-5', projectRoot);
    const jobId = 'completed-job';

    createdJobIds.add(jobId);
    progressStore.initJob(jobId, session.sessionId, 'codex', projectRoot);
    progressStore.updatePhase(jobId, 'completed');
    new SessionManager(projectRoot).claimForJobSync(session.sessionId, jobId);

    await startBackendServer({ progressStore });

    expect(new SessionManager(projectRoot).get('codex', session.sessionId)).toMatchObject({
      sessionId: session.sessionId,
      activeJobId: jobId,
    });
  });

  it('recovers orphaned workflow jobs with an empty artifact, workflow marker, and released session claim', async () => {
    const progressStore = new ProgressStore();
    const jobId = 'workflow-orphan-job';
    const projectRoot = createProjectRoot('workflow-project');
    const session = new SessionManager(projectRoot).allocate('codex', 'workflow-session', 'gpt-5', projectRoot);

    createdJobIds.add(jobId);
    progressStore.initJob(jobId, session.sessionId, 'codex', projectRoot, 'workflow');
    progressStore.updatePhase(jobId, 'running');
    new SessionManager(projectRoot).claimForJobSync(session.sessionId, jobId);

    const backend = await startBackendServer({ progressStore });
    const response = await fetch(`${backend.baseUrl}/wait/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': backend.token,
      },
      body: JSON.stringify({
        jobIds: [jobId],
        timeoutSeconds: 1,
        projectRoot,
      }),
    });
    const body = await response.text();
    const status = progressStore.readStatus(jobId);
    const recoveredSession = new SessionManager(projectRoot).get('codex', session.sessionId);

    expect(response.status).toBe(200);
    expect(body).toContain('event: terminal');
    expect(body).toContain(`"resultPath":"${jobResultPath(jobId)}"`);
    expect(body).toContain('"workflow":{"steps":[]}');
    expect(readFileSync(jobResultPath(jobId), 'utf-8')).toBe('');
    expect(status).toMatchObject({
      phase: 'error',
      jobKind: 'workflow',
      result: {
        content: '',
        notice: 'Unclean shutdown - orphaned job',
        workflow: { steps: [] },
      },
    });
    expect(recoveredSession?.activeJobId).toBeUndefined();
    expect(recoveredSession?.lastJobId).toBe(jobId);
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
