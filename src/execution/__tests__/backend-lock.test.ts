import { describe, expect, it, vi } from 'vitest';
import {
  acquireLock,
  BackendAlreadyRunningError,
  removeLockIfOwner,
  type LockRecord,
  type VerifyBackendOwnershipFn,
} from '../backend-lock.js';

function makeEnoent(path: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

class FakeLockStorage {
  private readonly files = new Map<string, string>();

  backendLockPath(pluginRoot: string): string {
    return `${pluginRoot}/backend.lock`;
  }

  readFileSync(path: string, _encoding: 'utf-8'): string {
    const value = this.files.get(path);
    if (value === undefined) {
      throw makeEnoent(path);
    }
    return value;
  }

  tryExclusiveWriteSync(path: string, data: string): boolean {
    if (this.files.has(path)) {
      return false;
    }
    this.files.set(path, data);
    return true;
  }

  renameSync(oldPath: string, newPath: string): void {
    const value = this.files.get(oldPath);
    if (value === undefined) {
      throw makeEnoent(oldPath);
    }
    this.files.delete(oldPath);
    this.files.set(newPath, value);
  }

  unlinkSync(path: string): void {
    if (!this.files.delete(path)) {
      throw makeEnoent(path);
    }
  }

  writeLock(pluginRoot: string, record: LockRecord): void {
    this.files.set(this.backendLockPath(pluginRoot), JSON.stringify(record));
  }

  readLock(pluginRoot: string): LockRecord | null {
    const raw = this.files.get(this.backendLockPath(pluginRoot));
    return raw ? (JSON.parse(raw) as LockRecord) : null;
  }
}

class FakeTime {
  nowMs = 0;
  readonly sleeps: number[] = [];

  now(): number {
    return this.nowMs;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.nowMs += ms;
  }
}

function makeLockRecord(overrides: Partial<LockRecord> = {}): LockRecord {
  return {
    instanceId: 'owner-a',
    pid: 111,
    version: '1.0.0',
    bundleHash: 'bundle-a',
    flavor: 'prod',
    startedAt: 10,
    ...overrides,
  };
}

describe('backend-lock', () => {
  it('uses the injected ownership verifier and runtime-backed storage/time while contending', async () => {
    const storage = new FakeLockStorage();
    const time = new FakeTime();
    const pluginRoot = '/plugin-root';
    storage.writeLock(pluginRoot, makeLockRecord());

    const verifyOwnership = vi
      .fn<VerifyBackendOwnershipFn>()
      .mockResolvedValueOnce('contended')
      .mockResolvedValueOnce('stale');

    await acquireLock(pluginRoot, 'owner-b', '2.0.0', 'bundle-b', 'prod', {
      env: { pid: () => 222 } as never,
      storage: storage as never,
      paths: storage as never,
      time: time as never,
      verifyOwnership,
    });

    expect(verifyOwnership).toHaveBeenCalledTimes(2);
    expect(time.sleeps).toEqual([200]);
    expect(storage.readLock(pluginRoot)).toMatchObject({
      instanceId: 'owner-b',
      pid: 222,
      version: '2.0.0',
      bundleHash: 'bundle-b',
      startedAt: 0,
    });
  });

  it('throws when the injected ownership verifier reports a healthy backend', async () => {
    const storage = new FakeLockStorage();
    const time = new FakeTime();
    const pluginRoot = '/plugin-root';
    const original = makeLockRecord();
    storage.writeLock(pluginRoot, original);

    await expect(
      acquireLock(pluginRoot, 'owner-b', '2.0.0', 'bundle-b', 'prod', {
        env: { pid: () => 222 } as never,
        storage: storage as never,
        paths: storage as never,
        time: time as never,
        verifyOwnership: vi.fn<VerifyBackendOwnershipFn>().mockResolvedValue('healthy'),
      }),
    ).rejects.toBeInstanceOf(BackendAlreadyRunningError);

    expect(storage.readLock(pluginRoot)).toEqual(original);
  });

  it('removes only the matching owner lock via runtime-backed storage', () => {
    const storage = new FakeLockStorage();
    const pluginRoot = '/plugin-root';
    storage.writeLock(pluginRoot, makeLockRecord({ instanceId: 'owner-a' }));

    removeLockIfOwner(pluginRoot, 'owner-a', storage as never, storage as never);
    expect(storage.readLock(pluginRoot)).toBeNull();
  });
});
