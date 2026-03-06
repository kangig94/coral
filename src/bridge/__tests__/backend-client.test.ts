import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WaitStreamEvent } from '../../types.js';

let tmpDir = '';

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

vi.mock('../../execution/backend-info.js', () => ({
  BACKEND_INFO_PATH: backendInfoPath(),
  readBackendInfo: readBackendInfoMock,
}));

vi.mock('../../execution/backend-lock.js', () => ({
  BACKEND_LOCK_PATH: backendLockPath(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

type BridgeBackendClientModule = typeof import('../backend-client.js');

function makeInfo(overrides: Partial<{
  pid: number;
  port: number;
  token: string;
  version: string;
  instanceId: string;
  startedAt: number;
}> = {}) {
  return {
    pid: 1234,
    port: 4100,
    token: 'backend-token',
    version: '0.1.0',
    instanceId: 'backend-instance',
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

describe('bridge backend-client', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'coral-bridge-backend-client-test-'));
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

  it('reuses a healthy backend with the current version without spawning', async () => {
    const client = await loadBackendClientModule();
    const info = makeInfo();

    readBackendInfoMock.mockReturnValueOnce(info);
    fetchMock.mockResolvedValueOnce(jsonResponse({
      status: 'ok',
      version: info.version,
      instanceId: info.instanceId,
    }));

    await expect(client.ensureBackend()).resolves.toEqual({
      port: info.port,
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
      instanceId: started.instanceId,
    }));

    await expect(client.ensureBackend()).resolves.toEqual({
      port: started.port,
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
        instanceId: info.instanceId,
      }))
      .mockResolvedValueOnce(jsonResponse({ status: 'running', job: 'job-1', session: 'session-1' }));

    const result = await client.proxyToolCall('codex', { op: 'exec', prompt: 'hello' }, {
      projectRoot: '/tmp/project',
      pluginRoot: '/tmp/plugin',
    });

    expect(result).toEqual({ status: 'running', job: 'job-1', session: 'session-1' });
    expect(fetchMock).toHaveBeenNthCalledWith(2, `http://127.0.0.1:${info.port}/tool`, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': info.token,
      }),
      body: JSON.stringify({
        name: 'codex',
        args: { op: 'exec', prompt: 'hello' },
        context: { projectRoot: '/tmp/project', pluginRoot: '/tmp/plugin' },
      }),
    }));
  });

  it('streamWait parses SSE progress and terminal events', async () => {
    const client = await loadBackendClientModule();
    fetchMock.mockResolvedValueOnce(new Response([
      'event: progress',
      'id: eyJqb2JzIjp7ImpvYi0xIjo3fX0',
      'data: {"type":"progress","jobId":"job-1","sessionId":"session-1","eventId":7,"message":"working"}',
      '',
      'event: terminal',
      'id: eyJqb2JzIjp7ImpvYi0xIjo3fX0',
      'data: {"type":"terminal","completedJobId":"job-1","sessionId":"session-1","remainingJobIds":[],"result":{"text":"done"}}',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    const events: WaitStreamEvent[] = [];
    for await (const event of client.streamWait(
      ['job-1'],
      5,
      { port: 4100, token: 'backend-token' },
      'cursor-1',
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
        result: { text: 'done' },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:4100/wait/stream', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': 'backend-token',
        'Last-Event-ID': 'cursor-1',
      }),
      body: JSON.stringify({ jobIds: ['job-1'], timeoutSeconds: 5 }),
    }));
  });
});
