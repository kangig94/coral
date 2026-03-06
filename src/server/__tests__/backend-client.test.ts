import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jsonResult } from '../../shared/mcp-utils.js';

let tmpDir = '';

const {
  readBackendInfoMock,
  spawnMock,
  existsSyncMock,
  fetchMock,
} = vi.hoisted(() => ({
  readBackendInfoMock: vi.fn(),
  spawnMock: vi.fn(() => ({ unref: vi.fn() })),
  existsSyncMock: vi.fn(() => true),
  fetchMock: vi.fn(),
}));

function backendInfoPath(): string {
  return join(tmpDir, 'backend.json');
}

function backendLockPath(): string {
  return join(tmpDir, 'backend.lock');
}

vi.mock('../../backend/backend-info.js', () => ({
  BACKEND_INFO_PATH: backendInfoPath(),
  readBackendInfo: readBackendInfoMock,
}));

vi.mock('../../backend/backend-lock.js', () => ({
  BACKEND_LOCK_PATH: backendLockPath(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: existsSyncMock,
  };
});

type BackendClientModule = typeof import('../backend-client.js');

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

async function loadBackendClientModule(): Promise<BackendClientModule> {
  vi.resetModules();
  return import('../backend-client.js');
}

describe('backend-client', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'coral-backend-client-test-'));
    readBackendInfoMock.mockReset();
    spawnMock.mockClear();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);
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

  it('shuts down a version-mismatched backend, acquires the replacement lock, and spawns a new backend', async () => {
    const client = await loadBackendClientModule();
    const oldInfo = makeInfo({ version: '0.0.9', instanceId: 'old-backend', token: 'old-token', port: 4200 });
    const newInfo = makeInfo({ version: '0.1.0', instanceId: 'new-backend', token: 'new-token', port: 4300 });

    readBackendInfoMock
      .mockReturnValueOnce(oldInfo)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(newInfo);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        status: 'ok',
        version: oldInfo.version,
        instanceId: oldInfo.instanceId,
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        status: 'ok',
        version: newInfo.version,
        instanceId: newInfo.instanceId,
      }));

    await expect(client.ensureBackend()).resolves.toEqual({
      port: newInfo.port,
      token: newInfo.token,
      instanceId: newInfo.instanceId,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(2, `http://127.0.0.1:${oldInfo.port}/admin/shutdown`, expect.objectContaining({
      method: 'POST',
      headers: { 'X-Coral-Backend-Token': oldInfo.token },
    }));
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('recovers from stale or corrupt backend info by spawning a replacement backend', async () => {
    const client = await loadBackendClientModule();
    const started = makeInfo({ instanceId: 'recovered-backend' });

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

  it('proxyToolCall sends the authenticated tool request with projectRoot context', async () => {
    const client = await loadBackendClientModule();
    const info = makeInfo();

    readBackendInfoMock.mockReturnValueOnce(info);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        status: 'ok',
        version: info.version,
        instanceId: info.instanceId,
      }))
      .mockResolvedValueOnce(jsonResponse(jsonResult({ ok: true })));

    const result = await client.proxyToolCall('codex', { op: 'exec', prompt: 'hello' }, '/tmp/project');

    expect(result).toEqual(jsonResult({ ok: true }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, `http://127.0.0.1:${info.port}/tool`, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        'X-Coral-Backend-Token': info.token,
      }),
      body: JSON.stringify({
        name: 'codex',
        args: { op: 'exec', prompt: 'hello' },
        context: { projectRoot: '/tmp/project' },
      }),
    }));
  });
});
