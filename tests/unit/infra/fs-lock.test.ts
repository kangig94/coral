import { dirname } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { acquireDirectoryLock, acquireDirectoryLockSync, type DirectoryLockDeps } from '#src/infra/fs-lock.js';

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function createLockDeps(now: () => number): {
  deps: DirectoryLockDeps;
  directories: Map<string, number>;
  files: Set<string>;
  removed: string[];
} {
  const directories = new Map<string, number>();
  const files = new Set<string>();
  const removed: string[] = [];
  const deps: DirectoryLockDeps = {
    storage: {
      mkdirSync: (path) => {
        if (directories.has(path) || files.has(path)) {
          throw errno('EEXIST');
        }
        directories.set(path, now());
      },
      writeFileSync: (path) => {
        if (!directories.has(dirname(path))) {
          throw errno('ENOENT');
        }
        files.add(path);
      },
      unlinkSync: (path) => {
        if (!files.delete(path)) {
          throw errno('ENOENT');
        }
        removed.push(path);
      },
      rmSync: (path) => {
        removed.push(path);
        directories.delete(path);
        for (const file of [...files]) {
          if (file === path || file.startsWith(`${path}/`)) {
            files.delete(file);
          }
        }
        for (const dir of [...directories.keys()]) {
          if (dir.startsWith(`${path}/`)) {
            directories.delete(dir);
          }
        }
      },
      rmdirSync: (path) => {
        for (const file of files) {
          if (dirname(file) === path) {
            throw errno('ENOTEMPTY');
          }
        }
        for (const dir of directories.keys()) {
          if (dir !== path && dirname(dir) === path) {
            throw errno('ENOTEMPTY');
          }
        }
        if (!directories.delete(path)) {
          throw errno('ENOENT');
        }
        removed.push(path);
      },
      statSync: ((path: string) => {
        const mtimeMs = directories.get(path);
        if (mtimeMs === undefined) {
          throw errno('ENOENT');
        }
        return {
          size: 0,
          mtimeMs,
          isDirectory: () => true,
          isFile: () => false,
        };
      }) as DirectoryLockDeps['storage']['statSync'],
    },
    time: {
      now,
      sleep: vi.fn(async () => {}),
    },
  };
  return { deps, directories, files, removed };
}

describe('directory fs lock', () => {
  it('acquires and releases a sync lock with explicit deps', () => {
    let currentTime = 1000;
    const { deps, directories, removed } = createLockDeps(() => currentTime);

    const release = acquireDirectoryLockSync('/locks/session-1', deps, 100);

    expect(directories.has('/locks/session-1')).toBe(true);
    currentTime += 1;
    release();
    expect(directories.has('/locks/session-1')).toBe(false);
    expect(removed.at(-1)).toBe('/locks/session-1');
  });

  it('uses explicit sync deps for stale lock checks and removal', () => {
    const { deps, directories, removed } = createLockDeps(() => 31_000);
    directories.set('/locks/stale-session', 0);

    const release = acquireDirectoryLockSync('/locks/stale-session', deps, 100);

    expect(directories.has('/locks/stale-session')).toBe(true);
    expect(removed[0]).toBe('/locks/stale-session');
    release();
    expect(directories.has('/locks/stale-session')).toBe(false);
  });

  it('does not let a stale owner release remove a replacement lock', () => {
    let currentTime = 1000;
    const { deps, directories } = createLockDeps(() => currentTime);

    const staleOwnerRelease = acquireDirectoryLockSync('/locks/shared-session', deps, 100);
    currentTime += 31_000;
    const replacementRelease = acquireDirectoryLockSync('/locks/shared-session', deps, 100);

    staleOwnerRelease();

    expect(directories.has('/locks/shared-session')).toBe(true);

    replacementRelease();
    expect(directories.has('/locks/shared-session')).toBe(false);
  });

  it('aborts async acquire while waiting for a busy lock', async () => {
    const { deps, directories } = createLockDeps(() => 1000);
    directories.set('/locks/busy-session', 1000);
    const controller = new AbortController();
    let sleepStarted!: () => void;
    const sleepStartedPromise = new Promise<void>((resolve) => {
      sleepStarted = resolve;
    });
    deps.time.sleep = vi.fn(
      () =>
        new Promise<void>(() => {
          sleepStarted();
        }),
    );

    const promise = acquireDirectoryLock('/locks/busy-session', { ...deps, signal: controller.signal }, 10_000);
    await sleepStartedPromise;
    const reason = new Error('stop waiting');
    controller.abort(reason);

    await expect(promise).rejects.toBe(reason);
    expect(directories.has('/locks/busy-session')).toBe(true);
  });
});
