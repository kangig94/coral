import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpHome = '';

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }),
}));

type BackendLockModule = typeof import('../backend-lock.js');

async function loadBackendLockModule(): Promise<BackendLockModule> {
  vi.resetModules();
  return import('../backend-lock.js');
}

function readLockFile(lockPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(lockPath, 'utf-8')) as Record<string, unknown>;
}

function injectLock(lockPath: string, content: string): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, content, 'utf-8');
}

describe('backend-lock', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'coral-backend-lock-test-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(tmpHome, { recursive: true, force: true });
    tmpHome = '';
  });

  it('lets only one acquireLock caller own the lock until the owner releases it', async () => {
    const backendLock = await loadBackendLockModule();

    await backendLock.acquireLock('owner-1', '1.0.0');
    expect(readLockFile(backendLock.BACKEND_LOCK_PATH).instanceId).toBe('owner-1');

    let secondResolved = false;
    const secondAcquire = backendLock.acquireLock('owner-2', '1.0.0').then(() => {
      secondResolved = true;
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(secondResolved).toBe(false);

    backendLock.removeLockIfOwner('owner-1');
    await vi.advanceTimersByTimeAsync(500);
    await secondAcquire;

    expect(readLockFile(backendLock.BACKEND_LOCK_PATH).instanceId).toBe('owner-2');
  });

  it('removeLockIfOwner leaves foreign locks alone and removes its own lock', async () => {
    const backendLock = await loadBackendLockModule();

    await backendLock.acquireLock('owner-1', '1.0.0');
    backendLock.removeLockIfOwner('foreign-owner');
    expect(existsSync(backendLock.BACKEND_LOCK_PATH)).toBe(true);

    backendLock.removeLockIfOwner('owner-1');
    expect(existsSync(backendLock.BACKEND_LOCK_PATH)).toBe(false);
  });

  it('treats an invalid lock file as startup-in-progress until the deadline, then replaces it', async () => {
    const backendLock = await loadBackendLockModule();

    mkdirSync(dirname(backendLock.BACKEND_LOCK_PATH), { recursive: true });
    writeFileSync(backendLock.BACKEND_LOCK_PATH, '{invalid-json', 'utf-8');

    let acquired = false;
    const acquirePromise = backendLock.acquireLock('replacement-owner', '1.0.0').then(() => {
      acquired = true;
    });

    await vi.advanceTimersByTimeAsync(backendLock.STARTUP_DEADLINE - 1_000);
    expect(acquired).toBe(false);

    await vi.advanceTimersByTimeAsync(1_500);
    await acquirePromise;

    expect(readLockFile(backendLock.BACKEND_LOCK_PATH).instanceId).toBe('replacement-owner');
  });

  it('replaces a dead owner lock', async () => {
    const backendLock = await loadBackendLockModule();

    mkdirSync(dirname(backendLock.BACKEND_LOCK_PATH), { recursive: true });
    writeFileSync(backendLock.BACKEND_LOCK_PATH, JSON.stringify({
      instanceId: 'dead-owner',
      pid: 999_999,
      version: '0.9.0',
      startedAt: Date.now(),
    }), 'utf-8');

    await backendLock.acquireLock('new-owner', '1.0.0');

    expect(readLockFile(backendLock.BACKEND_LOCK_PATH).instanceId).toBe('new-owner');
  });

  it('throws BackendAlreadyRunningError when a live owner with matching backend.json + healthy /health exists', async () => {
    const backendLock = await loadBackendLockModule();

    const lockRecord = {
      instanceId: 'live-owner',
      pid: process.pid,
      version: '1.0.0',
      startedAt: Date.now(),
    };
    injectLock(backendLock.BACKEND_LOCK_PATH, JSON.stringify(lockRecord));

    const backendInfoPath = join(tmpHome, '.claude', 'coral', 'backend.json');
    writeFileSync(backendInfoPath, JSON.stringify({
      pid: process.pid,
      port: 9999,
      token: 'tok',
      version: '1.0.0',
      instanceId: 'live-owner',
      startedAt: lockRecord.startedAt,
    }), 'utf-8');

    const healthBody = JSON.stringify({ status: 'ok', version: '1.0.0', instanceId: 'live-owner' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(healthBody, { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ));

    const acquirePromise = backendLock.acquireLock('challenger', '1.0.0');
    void acquirePromise.catch(() => {});
    await vi.runAllTimersAsync();

    await expect(acquirePromise).rejects.toThrow('already running');

    vi.unstubAllGlobals();
  });

  it('removeLockIfOwner is silent when lock file does not exist', async () => {
    const backendLock = await loadBackendLockModule();
    expect(() => backendLock.removeLockIfOwner('no-lock-owner')).not.toThrow();
  });

  it('removeLockIfOwner ignores a lock whose instanceId is a prefix of the caller instanceId', async () => {
    const backendLock = await loadBackendLockModule();

    const lockRecord = {
      instanceId: 'foreign-owner',
      pid: process.pid,
      version: '1.0.0',
      startedAt: Date.now(),
    };
    injectLock(backendLock.BACKEND_LOCK_PATH, JSON.stringify(lockRecord));

    backendLock.removeLockIfOwner('foreign-owner-extended');
    expect(existsSync(backendLock.BACKEND_LOCK_PATH)).toBe(true);
    expect(readLockFile(backendLock.BACKEND_LOCK_PATH)).toMatchObject({ instanceId: 'foreign-owner' });
  });

  it('treats a lock with missing pid as invalid and waits until STARTUP_DEADLINE before replacing', async () => {
    const backendLock = await loadBackendLockModule();

    injectLock(backendLock.BACKEND_LOCK_PATH, JSON.stringify({ instanceId: 'partial', version: '1.0.0' }));

    let acquired = false;
    const acquirePromise = backendLock.acquireLock('new-owner', '1.0.0').then(() => { acquired = true; });

    await vi.advanceTimersByTimeAsync(backendLock.STARTUP_DEADLINE - 1_000);
    expect(acquired).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    await acquirePromise;

    expect(acquired).toBe(true);
    expect(readLockFile(backendLock.BACKEND_LOCK_PATH).instanceId).toBe('new-owner');
  });

  it('treats a lock with startedAt=0 as invalid', async () => {
    const backendLock = await loadBackendLockModule();

    injectLock(backendLock.BACKEND_LOCK_PATH, JSON.stringify({
      instanceId: 'zero-started',
      pid: process.pid,
      version: '1.0.0',
      startedAt: 0,
    }));

    let acquired = false;
    const acquirePromise = backendLock.acquireLock('new-owner', '1.0.0').then(() => { acquired = true; });

    await vi.advanceTimersByTimeAsync(backendLock.STARTUP_DEADLINE - 500);
    expect(acquired).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await acquirePromise;

    expect(readLockFile(backendLock.BACKEND_LOCK_PATH).instanceId).toBe('new-owner');
  });

  it('resets the STARTUP_DEADLINE when the lock content changes', async () => {
    const backendLock = await loadBackendLockModule();

    injectLock(backendLock.BACKEND_LOCK_PATH, '{invalid');

    let acquired = false;
    const acquirePromise = backendLock.acquireLock('waiter', '1.0.0').then(() => { acquired = true; });

    await vi.advanceTimersByTimeAsync(backendLock.STARTUP_DEADLINE - 2_000);
    expect(acquired).toBe(false);

    injectLock(backendLock.BACKEND_LOCK_PATH, '{also-invalid}');

    await vi.advanceTimersByTimeAsync(backendLock.STARTUP_DEADLINE - 2_000);
    expect(acquired).toBe(false);

    await vi.advanceTimersByTimeAsync(3_000);
    await acquirePromise;

    expect(acquired).toBe(true);
  });

  it('acquireLock writes the correct record fields', async () => {
    const backendLock = await loadBackendLockModule();
    await backendLock.acquireLock('instance-x', '2.0.0');

    const record = readLockFile(backendLock.BACKEND_LOCK_PATH);
    expect(record.instanceId).toBe('instance-x');
    expect(record.version).toBe('2.0.0');
    expect(record.pid).toBe(process.pid);
    expect(typeof record.startedAt).toBe('number');
    expect((record.startedAt as number)).toBeGreaterThan(0);
  });
});
