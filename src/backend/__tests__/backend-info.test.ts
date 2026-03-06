import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpHome = '';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

type BackendInfoModule = typeof import('../backend-info.js');

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
    port: 4321,
    token: 'backend-token',
    version: '1.2.3',
    instanceId: 'instance-1',
    startedAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function loadBackendInfoModule(): Promise<BackendInfoModule> {
  vi.resetModules();
  return import('../backend-info.js');
}

describe('backend-info', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'coral-backend-info-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = '';
  });

  it('writes and reads backend info as a round-trip', async () => {
    const backendInfo = await loadBackendInfoModule();
    const info = makeInfo();

    backendInfo.writeBackendInfo(info);

    expect(backendInfo.readBackendInfo()).toEqual(info);
  });

  it('returns null for missing, corrupt, truncated, and incomplete files', async () => {
    const backendInfo = await loadBackendInfoModule();
    mkdirSync(join(tmpHome, '.claude', 'coral'), { recursive: true });

    expect(backendInfo.readBackendInfo()).toBeNull();

    writeFileSync(backendInfo.BACKEND_INFO_PATH, '{not-json', 'utf-8');
    expect(backendInfo.readBackendInfo()).toBeNull();

    writeFileSync(backendInfo.BACKEND_INFO_PATH, '{"pid":1234', 'utf-8');
    expect(backendInfo.readBackendInfo()).toBeNull();

    writeFileSync(backendInfo.BACKEND_INFO_PATH, JSON.stringify({ pid: 1234, port: 4321 }), 'utf-8');
    expect(backendInfo.readBackendInfo()).toBeNull();
  });

  it('removes backend info only when the instance owns the file', async () => {
    const backendInfo = await loadBackendInfoModule();
    const info = makeInfo();

    backendInfo.writeBackendInfo(info);
    backendInfo.removeBackendInfoIfOwner('different-instance');
    expect(existsSync(backendInfo.BACKEND_INFO_PATH)).toBe(true);

    backendInfo.removeBackendInfoIfOwner(info.instanceId);
    expect(existsSync(backendInfo.BACKEND_INFO_PATH)).toBe(false);
  });

  it('persists all required backend fields to disk', async () => {
    const backendInfo = await loadBackendInfoModule();
    const info = makeInfo();

    backendInfo.writeBackendInfo(info);

    const written = JSON.parse(readFileSync(backendInfo.BACKEND_INFO_PATH, 'utf-8')) as Record<string, unknown>;

    expect(Object.keys(written).sort()).toEqual([
      'instanceId',
      'pid',
      'port',
      'startedAt',
      'token',
      'version',
    ]);
    expect(written).toEqual(info);
  });

  it('leaves no .tmp file after writeBackendInfo', async () => {
    const backendInfo = await loadBackendInfoModule();
    backendInfo.writeBackendInfo(makeInfo());

    const tmpPath = `${backendInfo.BACKEND_INFO_PATH}.tmp`;
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(backendInfo.BACKEND_INFO_PATH)).toBe(true);
  });

  it('overwrites an existing backend.json with new data', async () => {
    const backendInfo = await loadBackendInfoModule();

    backendInfo.writeBackendInfo(makeInfo({ pid: 1111, instanceId: 'first' }));
    backendInfo.writeBackendInfo(makeInfo({ pid: 2222, instanceId: 'second' }));

    const result = backendInfo.readBackendInfo();
    expect(result?.pid).toBe(2222);
    expect(result?.instanceId).toBe('second');
  });

  it('returns null when pid is 0', async () => {
    const backendInfo = await loadBackendInfoModule();
    mkdirSync(join(tmpHome, '.claude', 'coral'), { recursive: true });
    writeFileSync(backendInfo.BACKEND_INFO_PATH, JSON.stringify(makeInfo({ pid: 0 })), 'utf-8');
    expect(backendInfo.readBackendInfo()).toBeNull();
  });

  it('returns null when pid is negative', async () => {
    const backendInfo = await loadBackendInfoModule();
    mkdirSync(join(tmpHome, '.claude', 'coral'), { recursive: true });
    writeFileSync(backendInfo.BACKEND_INFO_PATH, JSON.stringify(makeInfo({ pid: -1 })), 'utf-8');
    expect(backendInfo.readBackendInfo()).toBeNull();
  });

  it('returns null when port is 0', async () => {
    const backendInfo = await loadBackendInfoModule();
    mkdirSync(join(tmpHome, '.claude', 'coral'), { recursive: true });
    writeFileSync(backendInfo.BACKEND_INFO_PATH, JSON.stringify(makeInfo({ port: 0 })), 'utf-8');
    expect(backendInfo.readBackendInfo()).toBeNull();
  });

  it('returns null when port is negative', async () => {
    const backendInfo = await loadBackendInfoModule();
    mkdirSync(join(tmpHome, '.claude', 'coral'), { recursive: true });
    writeFileSync(backendInfo.BACKEND_INFO_PATH, JSON.stringify(makeInfo({ port: -80 })), 'utf-8');
    expect(backendInfo.readBackendInfo()).toBeNull();
  });

  it('returns null when startedAt is 0', async () => {
    const backendInfo = await loadBackendInfoModule();
    mkdirSync(join(tmpHome, '.claude', 'coral'), { recursive: true });
    writeFileSync(backendInfo.BACKEND_INFO_PATH, JSON.stringify(makeInfo({ startedAt: 0 })), 'utf-8');
    expect(backendInfo.readBackendInfo()).toBeNull();
  });

  it('returns null when startedAt is negative', async () => {
    const backendInfo = await loadBackendInfoModule();
    mkdirSync(join(tmpHome, '.claude', 'coral'), { recursive: true });
    writeFileSync(backendInfo.BACKEND_INFO_PATH, JSON.stringify(makeInfo({ startedAt: -1 })), 'utf-8');
    expect(backendInfo.readBackendInfo()).toBeNull();
  });

  it('returns null when pid is a float', async () => {
    const backendInfo = await loadBackendInfoModule();
    mkdirSync(join(tmpHome, '.claude', 'coral'), { recursive: true });
    writeFileSync(backendInfo.BACKEND_INFO_PATH, JSON.stringify(makeInfo({ pid: 12.5 })), 'utf-8');
    expect(backendInfo.readBackendInfo()).toBeNull();
  });

  it('returns null when port is a float', async () => {
    const backendInfo = await loadBackendInfoModule();
    mkdirSync(join(tmpHome, '.claude', 'coral'), { recursive: true });
    writeFileSync(backendInfo.BACKEND_INFO_PATH, JSON.stringify(makeInfo({ port: 4321.9 })), 'utf-8');
    expect(backendInfo.readBackendInfo()).toBeNull();
  });

  it('returns null when token is empty string', async () => {
    const backendInfo = await loadBackendInfoModule();
    mkdirSync(join(tmpHome, '.claude', 'coral'), { recursive: true });
    writeFileSync(backendInfo.BACKEND_INFO_PATH, JSON.stringify(makeInfo({ token: '' })), 'utf-8');
    expect(backendInfo.readBackendInfo()).toBeNull();
  });

  it('returns null when version is empty string', async () => {
    const backendInfo = await loadBackendInfoModule();
    mkdirSync(join(tmpHome, '.claude', 'coral'), { recursive: true });
    writeFileSync(backendInfo.BACKEND_INFO_PATH, JSON.stringify(makeInfo({ version: '' })), 'utf-8');
    expect(backendInfo.readBackendInfo()).toBeNull();
  });

  it('returns null when instanceId is empty string', async () => {
    const backendInfo = await loadBackendInfoModule();
    mkdirSync(join(tmpHome, '.claude', 'coral'), { recursive: true });
    writeFileSync(backendInfo.BACKEND_INFO_PATH, JSON.stringify(makeInfo({ instanceId: '' })), 'utf-8');
    expect(backendInfo.readBackendInfo()).toBeNull();
  });

  it('returns null when pid is a string', async () => {
    const backendInfo = await loadBackendInfoModule();
    mkdirSync(join(tmpHome, '.claude', 'coral'), { recursive: true });
    const bad = { ...makeInfo(), pid: '1234' };
    writeFileSync(backendInfo.BACKEND_INFO_PATH, JSON.stringify(bad), 'utf-8');
    expect(backendInfo.readBackendInfo()).toBeNull();
  });

  it('removeBackendInfoIfOwner is silent when file does not exist', async () => {
    const backendInfo = await loadBackendInfoModule();
    mkdirSync(join(tmpHome, '.claude', 'coral'), { recursive: true });
    expect(() => backendInfo.removeBackendInfoIfOwner('any-instance')).not.toThrow();
  });

  it('removeBackendInfoIfOwner does not throw when file vanishes between read and unlink', async () => {
    const backendInfo = await loadBackendInfoModule();
    backendInfo.writeBackendInfo(makeInfo({ instanceId: 'owner' }));
    backendInfo.removeBackendInfoIfOwner('owner');
    expect(() => backendInfo.removeBackendInfoIfOwner('owner')).not.toThrow();
    expect(existsSync(backendInfo.BACKEND_INFO_PATH)).toBe(false);
  });
});
