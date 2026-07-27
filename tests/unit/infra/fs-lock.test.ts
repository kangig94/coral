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
  replaceDirectoryBeforeOwnerWrite(): void;
  seedClaim(lockDir: string, mtimeMs: number): void;
  failNextQuarantine(): void;
} {
  const directories = new Map<string, number>();
  const files = new Set<string>();
  const fileMtimes = new Map<string, number>();
  const directoryInodes = new Map<string, bigint>();
  const removed: string[] = [];
  let nextInode = 1n;
  let refreshClaim = false;
  let replaceBeforeOwnerWrite = false;
  let failQuarantine = false;
  const deps: DirectoryLockDeps = {
    storage: {
      mkdirSync: (path) => {
        if (directories.has(path) || files.has(path)) {
          throw errno('EEXIST');
        }
        directories.set(path, now());
        directoryInodes.set(path, nextInode++);
      },
      writeFileSync: (path) => {
        const parent = dirname(path);
        if (!directories.has(parent)) {
          throw errno('ENOENT');
        }
        if (replaceBeforeOwnerWrite && path.includes('/owner-')) {
          replaceBeforeOwnerWrite = false;
          directories.set(parent, now());
          directoryInodes.set(parent, nextInode++);
          const replacementOwner = `${parent}/owner-replacement.lock`;
          files.add(replacementOwner);
          fileMtimes.set(replacementOwner, now());
        }
        files.add(path);
        fileMtimes.set(path, now());
      },
      renameSync: (oldPath, newPath) => {
        if (failQuarantine && newPath.includes('.stale-')) {
          failQuarantine = false;
          throw errno('EACCES');
        }
        if (files.delete(oldPath)) {
          if (files.has(newPath)) {
            files.add(oldPath);
            throw errno('EEXIST');
          }
          files.add(newPath);
          fileMtimes.set(newPath, fileMtimes.get(oldPath) ?? now());
          fileMtimes.delete(oldPath);
          if (refreshClaim && newPath.includes('/claim-')) {
            fileMtimes.set(newPath, now());
            refreshClaim = false;
          }
          return;
        }
        if (!directories.has(oldPath)) {
          throw errno('ENOENT');
        }
        if (directories.has(newPath)) {
          throw errno('EEXIST');
        }
        directories.set(newPath, directories.get(oldPath)!);
        directoryInodes.set(newPath, directoryInodes.get(oldPath) ?? nextInode++);
        directories.delete(oldPath);
        directoryInodes.delete(oldPath);
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
        directoryInodes.delete(path);
        for (const file of [...files]) {
          if (file === path || file.startsWith(`${path}/`)) {
            files.delete(file);
            fileMtimes.delete(file);
          }
        }
        for (const dir of [...directories.keys()]) {
          if (dir.startsWith(`${path}/`)) {
            directories.delete(dir);
            directoryInodes.delete(dir);
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
        directoryInodes.delete(path);
        removed.push(path);
      },
      statSync: ((path: string, options?: { bigint?: true }) => {
        const mtimeMs = directories.get(path);
        const fileMtimeMs = fileMtimes.get(path);
        if (mtimeMs === undefined && fileMtimeMs === undefined) {
          throw errno('ENOENT');
        }
        if (options?.bigint === true) {
          const isDirectory = mtimeMs !== undefined;
          let ino = directoryInodes.get(path);
          if (isDirectory && ino === undefined) {
            ino = nextInode++;
            directoryInodes.set(path, ino);
          }
          return {
            dev: 1n,
            ino: ino ?? nextInode++,
            mode: 0n,
            size: 0n,
            mtimeNs: BigInt(Math.floor((mtimeMs ?? fileMtimeMs!) * 1_000_000)),
            isDirectory: () => isDirectory,
            isFile: () => !isDirectory,
          };
        }
        return {
          size: 0,
          mtimeMs: mtimeMs ?? fileMtimeMs!,
          isDirectory: () => mtimeMs !== undefined,
          isFile: () => fileMtimeMs !== undefined,
        };
      }) as DirectoryLockDeps['storage']['statSync'],
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
    replaceDirectoryBeforeOwnerWrite: () => {
      replaceBeforeOwnerWrite = true;
    },
    seedClaim: (lockDir, mtimeMs) => {
      directories.set(lockDir, mtimeMs);
      directoryInodes.set(lockDir, nextInode++);
      const claimPath = `${lockDir}/claim-crashed.lock`;
      files.add(claimPath);
      fileMtimes.set(claimPath, mtimeMs);
    },
    failNextQuarantine: () => {
      failQuarantine = true;
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

  it('rejects a creator displaced before its owner marker write', () => {
    const fixture = createLockDeps(() => 1000);
    fixture.replaceDirectoryBeforeOwnerWrite();

    expect(() => acquireDirectoryLockSync('/locks/publish-race', fixture.deps, 100)).toThrow(/ownership lost/u);

    expect(fixture.directories.has('/locks/publish-race')).toBe(true);
    expect([...fixture.files].filter((path) => path.includes('/owner-'))).toEqual([
      '/locks/publish-race/owner-replacement.lock',
    ]);
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

  it('refreshes explicit ownership checks before a stale contender can claim', () => {
    let currentTime = 0;
    let nowCalls = 0;
    const fixture = createLockDeps(() => currentTime + nowCalls++ * 50);
    const release = acquireDirectoryLockSync('/locks/resumed-session', fixture.deps, 100);
    currentTime = 31_000;
    nowCalls = 0;

    expect(() => release.assertOwned()).not.toThrow();
    expect(() => acquireDirectoryLockSync('/locks/resumed-session', fixture.deps, 100)).toThrow(
      /Directory lock timeout/u,
    );
    release();
  });

  it('recovers a stale claim left by a crashed contender', () => {
    const fixture = createLockDeps(() => 31_000);
    fixture.seedClaim('/locks/crashed-claim', 0);

    const release = acquireDirectoryLockSync('/locks/crashed-claim', fixture.deps, 100);

    expect(fixture.directories.has('/locks/crashed-claim')).toBe(true);
    expect(fixture.removed.some((path) => path.startsWith('/locks/crashed-claim.stale-'))).toBe(true);
    release();
  });

  it('restores a claimed owner when quarantine fails so a retry can recover', () => {
    let currentTime = 0;
    const fixture = createLockDeps(() => currentTime);
    const staleOwner = acquireDirectoryLockSync('/locks/quarantine-failure', fixture.deps, 100);
    currentTime = 31_000;
    fixture.failNextQuarantine();

    expect(() => acquireDirectoryLockSync('/locks/quarantine-failure', fixture.deps, 100)).toThrow(/EACCES/u);
    expect([...fixture.files].some((path) => path.includes('/owner-'))).toBe(true);

    const replacement = acquireDirectoryLockSync('/locks/quarantine-failure', fixture.deps, 100);
    expect(() => staleOwner.assertOwned()).toThrow(/ownership lost/u);
    staleOwner();
    replacement();
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
