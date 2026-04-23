import { describe, expect, it } from 'vitest';
import { acquireLock, releaseLock, type LockRecord } from '../lock.js';
import { coordinatorPaths } from '../../infra/coordinator-paths.js';

function makeEnoent(path: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

class FakeLockStorage {
  private readonly files = new Map<string, string>();

  lockPath(flavor: 'prod' | 'dev'): string {
    return coordinatorPaths(flavor).lockFile;
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

  writeLock(flavor: 'prod' | 'dev', record: LockRecord): void {
    this.files.set(this.lockPath(flavor), JSON.stringify(record));
  }

  readLock(flavor: 'prod' | 'dev'): LockRecord | null {
    const raw = this.files.get(this.lockPath(flavor));
    return raw ? (JSON.parse(raw) as LockRecord) : null;
  }
}

class FakeTime {
  nowMs = 0;

  now(): number {
    return this.nowMs;
  }

  async sleep(ms: number): Promise<void> {
    this.nowMs += ms;
  }

  setTimeout(fn: () => void): number {
    fn();
    return 0;
  }

  clearTimeout(_handle: number): void {}
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
  it('replaces a stale lock and acquires the requested flavor/bundle with runtime-backed storage', async () => {
    const storage = new FakeLockStorage();
    const time = new FakeTime();
    storage.writeLock('prod', makeLockRecord());

    const record = await acquireLock('prod', 'bundle-b', {
      instanceId: 'owner-b',
      version: '2.0.0',
      runtime: {
        env: { pid: () => 222, platform: () => process.platform } as never,
        process: { isAlive: () => false } as never,
        storage: storage as never,
        time: time as never,
      },
    });

    expect(record).toMatchObject({
      instanceId: 'owner-b',
      pid: 222,
      version: '2.0.0',
      bundleHash: 'bundle-b',
      flavor: 'prod',
      startedAt: 0,
    });
    expect(storage.readLock('prod')).toMatchObject({
      instanceId: 'owner-b',
      pid: 222,
      version: '2.0.0',
      bundleHash: 'bundle-b',
      flavor: 'prod',
      startedAt: 0,
    });
  });

  it('releaseLock removes the active lock record when runtime-backed storage is provided', async () => {
    const storage = new FakeLockStorage();
    const time = new FakeTime();

    await acquireLock('dev', 'bundle-b', {
      instanceId: 'owner-b',
      version: '2.0.0',
      runtime: {
        env: { pid: () => 333, platform: () => process.platform } as never,
        process: { isAlive: () => false } as never,
        storage: storage as never,
        time: time as never,
      },
    });

    releaseLock('owner-b', { storage: storage as never } as never);
    expect(storage.readLock('dev')).toBeNull();
  });
});
