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
  refreshClaimOnRename(): void;
} {
  const directories = new Map<string, number>();
  const files = new Set<string>();
  const fileMtimes = new Map<string, number>();
  const removed: string[] = [];
  const openFiles = new Map<number, string>();
  let nextFd = 1;
  let refreshClaim = false;
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
        fileMtimes.set(path, now());
      },
      renameSync: (oldPath, newPath) => {
        if (files.delete(oldPath)) {
          files.add(newPath);
          fileMtimes.set(newPath, fileMtimes.get(oldPath) ?? now());
          fileMtimes.delete(oldPath);
          for (const [fd, path] of openFiles) {
            if (path === oldPath) {
              openFiles.set(fd, newPath);
            }
          }
          if (refreshClaim && newPath.includes('/claim-')) {
            fileMtimes.set(newPath, now());
            refreshClaim = false;
          }
          return;
        }
        if (!directories.has(oldPath)) {
          throw errno('ENOENT');
        }
        directories.set(newPath, directories.get(oldPath)!);
        directories.delete(oldPath);
        for (const file of [...files]) {
          if (file.startsWith(`${oldPath}/`)) {
            const moved = `${newPath}${file.slice(oldPath.length)}`;
            files.delete(file);
            files.add(moved);
            fileMtimes.set(moved, fileMtimes.get(file) ?? now());
            fileMtimes.delete(file);
          }
        }
      },
      readdirSync: ((path: string) =>
        [...files]
          .filter((file) => dirname(file) === path)
          .map((file) => file.slice(path.length + 1))) as DirectoryLockDeps['storage']['readdirSync'],
      unlinkSync: (path) => {
        if (!files.delete(path)) {
          throw errno('ENOENT');
        }
        fileMtimes.delete(path);
        removed.push(path);
      },
      rmSync: (path) => {
        removed.push(path);
        directories.delete(path);
        for (const file of [...files]) {
          if (file === path || file.startsWith(`${path}/`)) {
            files.delete(file);
            fileMtimes.delete(file);
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
        const fileMtimeMs = fileMtimes.get(path);
        if (mtimeMs === undefined && fileMtimeMs === undefined) {
          throw errno('ENOENT');
        }
        return {
          size: 0,
          mtimeMs: mtimeMs ?? fileMtimeMs!,
          isDirectory: () => mtimeMs !== undefined,
          isFile: () => fileMtimeMs !== undefined,
        };
      }) as DirectoryLockDeps['storage']['statSync'],
      openSync: (path) => {
        if (!files.has(path)) {
          throw errno('ENOENT');
        }
        const fd = nextFd++;
        openFiles.set(fd, path);
        return fd;
      },
      writeSync: (fd, _buffer, _offset, length) => {
        const path = openFiles.get(fd);
        if (path === undefined) {
          throw errno('EBADF');
        }
        fileMtimes.set(path, now());
        return length;
      },
      closeSync: (fd) => {
        openFiles.delete(fd);
      },
    },
    time: {
      now,
      sleep: vi.fn(async () => {}),
      setInterval: vi.fn(() => ({})),
      clearInterval: vi.fn(),
    },
  };
  return {
    deps,
    directories,
    files,
    removed,
    refreshClaimOnRename: () => {
      refreshClaim = true;
    },
  };
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
    let currentTime = 0;
    const { deps, directories, removed } = createLockDeps(() => currentTime);
    acquireDirectoryLockSync('/locks/stale-session', deps, 100);
    currentTime = 31_000;

    const release = acquireDirectoryLockSync('/locks/stale-session', deps, 100);

    expect(directories.has('/locks/stale-session')).toBe(true);
    expect(removed.some((path) => path.startsWith('/locks/stale-session.stale-'))).toBe(true);
    release();
    expect(directories.has('/locks/stale-session')).toBe(false);
  });

  it('does not let a stale owner release remove a replacement lock', () => {
    let currentTime = 1000;
    const { deps, directories } = createLockDeps(() => currentTime);

    const staleOwnerRelease = acquireDirectoryLockSync('/locks/shared-session', deps, 100);
    currentTime += 31_000;
    const replacementRelease = acquireDirectoryLockSync('/locks/shared-session', deps, 100);

    expect(() => staleOwnerRelease.assertOwned()).toThrow(/ownership lost/u);
    staleOwnerRelease();

    expect(directories.has('/locks/shared-session')).toBe(true);

    replacementRelease();
    expect(directories.has('/locks/shared-session')).toBe(false);
  });

  it('does not steal a lock whose owner refreshes during the stale claim', () => {
    let currentTime = 0;
    let nowCalls = 0;
    const fixture = createLockDeps(() => currentTime + nowCalls++ * 50);
    const release = acquireDirectoryLockSync('/locks/heartbeat-session', fixture.deps, 100);
    currentTime = 31_000;
    nowCalls = 0;
    fixture.refreshClaimOnRename();

    expect(() => acquireDirectoryLockSync('/locks/heartbeat-session', fixture.deps, 100)).toThrow(
      /Directory lock timeout/u,
    );
    expect(() => release.assertOwned()).not.toThrow();
    release();
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
