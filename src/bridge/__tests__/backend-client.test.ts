import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WaitStreamEvent } from '../../types.js';

let tmpDir = '';
const PKG_VERSION = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')).version as string;
const TEST_PLUGIN_ROOT = '/test/plugin/root';

function readTestBundleHash(): string {
  try {
    const raw = readFileSync(join(process.cwd(), 'bridge', 'manifest.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.bundleHash === 'string' ? parsed.bundleHash : 'unknown';
  } catch {
    return 'unknown';
  }
}
const BUNDLE_HASH = readTestBundleHash();

const {
  readBackendInfoMock,
  spawnMock,
  fetchMock,
} = vi.hoisted(() => ({
  readBackendInfoMock: vi.fn(),
  spawnMock: vi.fn(() => ({ unref: vi.fn() })),
  fetchMock: vi.fn(),
}));

function backendInfoPath(): string {
  return join(tmpDir, 'backend.json');
}

function backendLockPath(): string {
  return join(tmpDir, 'backend.lock');
}

function actualPluginRoot(): string {
  return join(tmpDir, 'plugin-root');
}

function actualPluginNamespace(): string {
  return createHash('sha256').update(realpathSync(actualPluginRoot())).digest('hex').slice(0, 12);
}

vi.mock('../../execution/backend-info.js', () => ({
  backendInfoPath,
  readBackendInfo: readBackendInfoMock,
}));

vi.mock('../../execution/backend-lock.js', () => ({
  backendLockPath,
}));

vi.mock('../../client/paths.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../client/paths.js')>();
  return {
    ...original,
    backendInfoPath,
    backendLockPath,
  };
});

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

type BridgeBackendClientModule = typeof import('../backend-client.js');

function makeInfo(overrides: Partial<{
  pid: number;
  port: number;
  token: string;
  version: string;
    bundleHash: string;
    instanceId: string;
    namespace: string;
    startedAt: number;
  }> = {}) {
  return {
    pid: 1234,
    port: 4100,
    host: '127.0.0.1',
    token: 'backend-token',
    version: PKG_VERSION,
    bundleHash: BUNDLE_HASH,
    instanceId: 'backend-instance',
    namespace: actualPluginNamespace(),
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function loadBackendClientModule(): Promise<BridgeBackendClientModule> {
  vi.resetModules();
  return import('../backend-client.js');
}

function makeBackendStatus(overrides: Partial<{
  version: string;
    bundleHash: string;
    instanceId: string;
    namespace: string;
    uptimeMs: number;
  activeChildren: number;
  activeJobs: number;
  inflightRequests: number;
}> = {}) {
  return {
    status: 'ok' as const,
    version: PKG_VERSION,
    bundleHash: BUNDLE_HASH,
    instanceId: 'backend-instance',
    namespace: actualPluginNamespace(),
    uptimeMs: 12_345,
    activeChildren: 2,
    activeJobs: 3,
    inflightRequests: 1,
    ...overrides,
  };
}

type TestBackendInfo = ReturnType<typeof makeInfo>;

function mockRunningBackend(info: TestBackendInfo = makeInfo()) {
  readBackendInfoMock.mockReturnValueOnce(info);
  return {
    info,
    killSpy: vi.spyOn(process, 'kill').mockReturnValue(true),
  };
}

function mockDeadBackendProcess(info: TestBackendInfo = makeInfo()) {
  readBackendInfoMock.mockReturnValueOnce(info);
  vi.spyOn(process, 'kill').mockImplementation(() => {
    const error = new Error('process not found') as NodeJS.ErrnoException;
    error.code = 'ESRCH';
    throw error;
  });
}

function expectHealthRequest(info: TestBackendInfo) {
  expect(fetchMock).toHaveBeenCalledWith(`http://127.0.0.1:${info.port}/health`, expect.objectContaining({
    method: 'GET',
    headers: { 'X-Coral-Backend-Token': info.token },
  }));
}

describe('bridge backend-client', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'coral-bridge-backend-client-test-'));
    mkdirSync(join(actualPluginRoot(), 'bridge'), { recursive: true });
    writeFileSync(
      join(actualPluginRoot(), 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: BUNDLE_HASH }, null, 2),
      'utf-8',
    );
    readBackendInfoMock.mockReset();
    spawnMock.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('getBackendStatus returns full health when the backend is running', async () => {
    const client = await loadBackendClientModule();
    const { info, killSpy } = mockRunningBackend();
    const status = makeBackendStatus({ version: info.version, instanceId: info.instanceId });

    fetchMock.mockResolvedValueOnce(jsonResponse(status));

    await expect(client.getBackendStatus(TEST_PLUGIN_ROOT)).resolves.toEqual({
      status: 'ok',
      version: status.version,
      bundleHash: status.bundleHash,
      instanceId: status.instanceId,
      uptimeMs: status.uptimeMs,
      activeChildren: status.activeChildren,
      activeJobs: status.activeJobs,
      inflightRequests: status.inflightRequests,
    });
    expect(readBackendInfoMock).toHaveBeenCalledWith(TEST_PLUGIN_ROOT);
    expect(killSpy).toHaveBeenCalledWith(info.pid, 0);
    expectHealthRequest(info);
  });

  it('getBackendStatusFull returns ok health when the backend is running', async () => {
    const client = await loadBackendClientModule();
    const { info, killSpy } = mockRunningBackend();
    const status = makeBackendStatus({ version: info.version, instanceId: info.instanceId });

    fetchMock.mockResolvedValueOnce(jsonResponse(status));

    await expect(client.getBackendStatusFull(TEST_PLUGIN_ROOT)).resolves.toEqual({
      status: 'ok',
      health: {
        status: 'ok',
        version: status.version,
        bundleHash: status.bundleHash,
        instanceId: status.instanceId,
        uptimeMs: status.uptimeMs,
        activeChildren: status.activeChildren,
        activeJobs: status.activeJobs,
        inflightRequests: status.inflightRequests,
      },
    });
    expect(readBackendInfoMock).toHaveBeenCalledWith(TEST_PLUGIN_ROOT);
    expect(killSpy).toHaveBeenCalledWith(info.pid, 0);
    expectHealthRequest(info);
  });

  it('getBackendStatus returns null when backend info is missing', async () => {
    const client = await loadBackendClientModule();

    readBackendInfoMock.mockReturnValueOnce(null);

    await expect(client.getBackendStatus(TEST_PLUGIN_ROOT)).resolves.toBeNull();
    expect(readBackendInfoMock).toHaveBeenCalledWith(TEST_PLUGIN_ROOT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getBackendStatusFull returns not_running when backend info is missing', async () => {
    const client = await loadBackendClientModule();

    readBackendInfoMock.mockReturnValueOnce(null);

    await expect(client.getBackendStatusFull(TEST_PLUGIN_ROOT)).resolves.toEqual({ status: 'not_running' });
    expect(readBackendInfoMock).toHaveBeenCalledWith(TEST_PLUGIN_ROOT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getBackendStatus returns null when the recorded pid is dead', async () => {
    const client = await loadBackendClientModule();
    mockDeadBackendProcess();

    await expect(client.getBackendStatus(TEST_PLUGIN_ROOT)).resolves.toBeNull();
    expect(readBackendInfoMock).toHaveBeenCalledWith(TEST_PLUGIN_ROOT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getBackendStatusFull returns not_running when the recorded pid is dead', async () => {
    const client = await loadBackendClientModule();
    mockDeadBackendProcess();

    await expect(client.getBackendStatusFull(TEST_PLUGIN_ROOT)).resolves.toEqual({ status: 'not_running' });
    expect(readBackendInfoMock).toHaveBeenCalledWith(TEST_PLUGIN_ROOT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getBackendStatus returns shutting_down during backend drain', async () => {
    const client = await loadBackendClientModule();
    mockRunningBackend();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'backend_shutting_down' }, 503));

    await expect(client.getBackendStatus(TEST_PLUGIN_ROOT)).resolves.toEqual({ status: 'shutting_down' });
    expect(readBackendInfoMock).toHaveBeenCalledWith(TEST_PLUGIN_ROOT);
  });

  it('getBackendStatusFull returns shutting_down during backend drain', async () => {
    const client = await loadBackendClientModule();
    mockRunningBackend();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'backend_shutting_down' }, 503));

    await expect(client.getBackendStatusFull(TEST_PLUGIN_ROOT)).resolves.toEqual({ status: 'shutting_down' });
    expect(readBackendInfoMock).toHaveBeenCalledWith(TEST_PLUGIN_ROOT);
  });

  it('getBackendStatus returns null on stale auth', async () => {
    const client = await loadBackendClientModule();
    mockRunningBackend();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401));

    await expect(client.getBackendStatus(TEST_PLUGIN_ROOT)).resolves.toBeNull();
    expect(readBackendInfoMock).toHaveBeenCalledWith(TEST_PLUGIN_ROOT);
  });

  it('getBackendStatusFull returns unauthorized on stale auth', async () => {
    const client = await loadBackendClientModule();
    mockRunningBackend();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401));

    await expect(client.getBackendStatusFull(TEST_PLUGIN_ROOT)).resolves.toEqual({ status: 'unauthorized' });
    expect(readBackendInfoMock).toHaveBeenCalledWith(TEST_PLUGIN_ROOT);
  });

  it('getBackendStatus returns null on connection errors', async () => {
    const client = await loadBackendClientModule();
    mockRunningBackend();
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    await expect(client.getBackendStatus(TEST_PLUGIN_ROOT)).resolves.toBeNull();
    expect(readBackendInfoMock).toHaveBeenCalledWith(TEST_PLUGIN_ROOT);
  });

  it('getBackendStatusFull returns not_running on connection errors', async () => {
    const client = await loadBackendClientModule();
    mockRunningBackend();
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    await expect(client.getBackendStatusFull(TEST_PLUGIN_ROOT)).resolves.toEqual({ status: 'not_running' });
    expect(readBackendInfoMock).toHaveBeenCalledWith(TEST_PLUGIN_ROOT);
  });

  it('shutdownBackend returns ok when shutdown starts', async () => {
    const client = await loadBackendClientModule();
    const { info } = mockRunningBackend();
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'shutting_down' }));

    await expect(client.shutdownBackend(TEST_PLUGIN_ROOT)).resolves.toEqual({ ok: true });
    expect(readBackendInfoMock).toHaveBeenCalledWith(TEST_PLUGIN_ROOT);
    expect(fetchMock).toHaveBeenCalledWith(`http://127.0.0.1:${info.port}/admin/shutdown`, expect.objectContaining({
      method: 'POST',
      headers: { 'X-Coral-Backend-Token': info.token },
    }));
  });

  it('shutdownBackend returns not_running when backend info is missing', async () => {
    const client = await loadBackendClientModule();

    readBackendInfoMock.mockReturnValueOnce(null);

    await expect(client.shutdownBackend(TEST_PLUGIN_ROOT)).resolves.toEqual({ ok: false, reason: 'not_running' });
    expect(readBackendInfoMock).toHaveBeenCalledWith(TEST_PLUGIN_ROOT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shutdownBackend is idempotent while the backend is draining', async () => {
    const client = await loadBackendClientModule();
    mockRunningBackend();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'backend_shutting_down' }, 503));

    await expect(client.shutdownBackend(TEST_PLUGIN_ROOT)).resolves.toEqual({ ok: true, alreadyDraining: true });
    expect(readBackendInfoMock).toHaveBeenCalledWith(TEST_PLUGIN_ROOT);
  });

  it('shutdownBackend returns unauthorized on stale auth', async () => {
    const client = await loadBackendClientModule();
    mockRunningBackend();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401));

    await expect(client.shutdownBackend(TEST_PLUGIN_ROOT)).resolves.toEqual({ ok: false, reason: 'unauthorized' });
    expect(readBackendInfoMock).toHaveBeenCalledWith(TEST_PLUGIN_ROOT);
  });

  it('shutdownBackend rejects malformed success payloads', async () => {
    const client = await loadBackendClientModule();
    mockRunningBackend();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(client.shutdownBackend(TEST_PLUGIN_ROOT)).resolves.toEqual({ ok: false, reason: '200 OK' });
    expect(readBackendInfoMock).toHaveBeenCalledWith(TEST_PLUGIN_ROOT);
  });

  it('shutdownBackend returns not_running on connection errors', async () => {
    const client = await loadBackendClientModule();
    mockRunningBackend();
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    await expect(client.shutdownBackend(TEST_PLUGIN_ROOT)).resolves.toEqual({ ok: false, reason: 'not_running' });
    expect(readBackendInfoMock).toHaveBeenCalledWith(TEST_PLUGIN_ROOT);
  });

  it('reuses a healthy backend with the current bundle hash without spawning', async () => {
    const client = await loadBackendClientModule();
    const info = makeInfo();

    readBackendInfoMock.mockReturnValueOnce(info);
    fetchMock.mockResolvedValueOnce(jsonResponse({
      status: 'ok',
      version: info.version,
      bundleHash: info.bundleHash,
      instanceId: info.instanceId,
      namespace: info.namespace,
    }));

    await expect(client.ensureBackend(actualPluginRoot())).resolves.toEqual({
      port: info.port,
      host: info.host,
      token: info.token,
      instanceId: info.instanceId,
    });

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('spawns and waits for a backend when no healthy backend exists', async () => {
    const client = await loadBackendClientModule();
    const started = makeInfo({ instanceId: 'new-backend' });

    readBackendInfoMock
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(started);
    fetchMock.mockResolvedValueOnce(jsonResponse({
      status: 'ok',
      version: started.version,
      bundleHash: started.bundleHash,
      instanceId: started.instanceId,
      namespace: started.namespace,
    }));

    await expect(client.ensureBackend(actualPluginRoot())).resolves.toEqual({
      port: started.port,
      host: started.host,
      token: started.token,
      instanceId: started.instanceId,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('proxyToolCall sends projectRoot and pluginRoot in the backend context', async () => {
    const client = await loadBackendClientModule();
    const info = makeInfo();

    readBackendInfoMock.mockReturnValueOnce(info);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        status: 'ok',
        version: info.version,
        bundleHash: info.bundleHash,
        instanceId: info.instanceId,
        namespace: info.namespace,
      }))
      .mockResolvedValueOnce(jsonResponse({ status: 'running', job: 'job-1', session: 'session-1' }));

    const result = await client.proxyToolCall('codex', { op: 'exec', prompt: 'hello' }, {
      projectRoot: '/tmp/project',
      pluginRoot: actualPluginRoot(),
    });

    expect(result).toEqual({ status: 'running', job: 'job-1', session: 'session-1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const toolCall = fetchMock.mock.calls[1];
    const toolCallInit = toolCall?.[1];
    expect(toolCallInit).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': info.token,
      }),
    });
    expect(JSON.parse(String(toolCallInit?.body))).toMatchObject({
      name: 'codex',
      args: { op: 'exec', prompt: 'hello' },
      context: {
        projectRoot: '/tmp/project',
        pluginRoot: actualPluginRoot(),
      },
    });
    const parsedBody = JSON.parse(String(toolCallInit?.body));
    expect(typeof parsedBody.context).toBe('object');
    expect(parsedBody.context.coralEnv).toBeDefined();
  });

  it('streamWait sends projectRoot and parses SSE progress and terminal events', async () => {
    const client = await loadBackendClientModule();
    fetchMock.mockResolvedValueOnce(new Response([
      'event: progress',
      'id: eyJqb2JzIjp7ImpvYi0xIjo3fX0',
      'data: {"type":"progress","jobId":"job-1","sessionId":"session-1","eventId":7,"message":"working"}',
      '',
      'event: terminal',
      'id: eyJqb2JzIjp7ImpvYi0xIjo3fX0',
      'data: {"type":"terminal","completedJobId":"job-1","sessionId":"session-1","remainingJobIds":[],"resultPath":"/tmp/coral-jobs/job-1/result.md","result":{"content":"done"}}',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    const events: WaitStreamEvent[] = [];
    for await (const event of client.streamWait(
      ['job-1'],
      5,
      { host: '127.0.0.1', port: 4100, token: 'backend-token' },
      'cursor-1',
      undefined,
      '/tmp/project',
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'progress',
        jobId: 'job-1',
        sessionId: 'session-1',
        eventId: 7,
        message: 'working',
      },
      {
        type: 'terminal',
        completedJobId: 'job-1',
        sessionId: 'session-1',
        remainingJobIds: [],
        resultPath: '/tmp/coral-jobs/job-1/result.md',
        result: { content: 'done' },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4100/wait/stream', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': 'backend-token',
        'Last-Event-ID': 'cursor-1',
      }),
      body: JSON.stringify({ jobIds: ['job-1'], timeoutSeconds: 5, projectRoot: '/tmp/project' }),
    }));
  });

  it('streamWait updates cursorRef with SSE id fields', async () => {
    const client = await loadBackendClientModule();
    fetchMock.mockResolvedValueOnce(new Response([
      'event: progress',
      'id: cursor-after-progress',
      'data: {"type":"progress","jobId":"job-1","sessionId":"s1","eventId":1,"message":"step 1"}',
      '',
      'event: progress',
      'id: cursor-after-progress-2',
      'data: {"type":"progress","jobId":"job-1","sessionId":"s1","eventId":2,"message":"step 2"}',
      '',
      'event: terminal',
      'id: cursor-final',
      'data: {"type":"terminal","completedJobId":"job-1","sessionId":"s1","remainingJobIds":[],"resultPath":"/tmp/r.md","result":{"content":"ok"}}',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    const cursorRef: { lastEventId?: string } = {};
    for await (const _event of client.streamWait(
      ['job-1'],
      5,
      { host: '127.0.0.1', port: 4100, token: 'tok' },
      undefined,
      undefined,
      undefined,
      cursorRef,
    )) {
      // consume
    }

    expect(cursorRef.lastEventId).toBe('cursor-final');
  });
});
