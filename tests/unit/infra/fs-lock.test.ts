import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireDirectoryLock,
  acquireDirectoryLockSync,
  attemptExclusiveFileLockSync,
  createSharedFileLockSync,
  repairMalformedFileLockSync,
  type DirectoryLockDeps,
  type DirectoryLockOwner,
} from '#src/infra/fs-lock.js';
import { processIncarnationSchema, type ProcessLiveness } from '#src/infra/node-process.js';

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function createLockDeps(
  now: () => number,
  monotonicNow: () => bigint = () => BigInt(now()),
): {
  deps: DirectoryLockDeps;
  directories: Map<string, number>;
  files: Set<string>;
  fileContents: Map<string, string>;
  removed: string[];
  claimRefreshBeforeWrite(): void;
  refreshClaimOnRename(): void;
  replaceDirectoryBeforeOwnerWrite(): void;
  seedClaim(lockDir: string, mtimeMs: number): void;
  failNextQuarantine(): void;
} {
  const directories = new Map<string, number>();
  const files = new Set<string>();
  const fileMtimes = new Map<string, number>();
  const fileContents = new Map<string, string>();
  const directoryInodes = new Map<string, bigint>();
  const removed: string[] = [];
  let nextInode = 1n;
  let claimRefresh = false;
  let refreshClaim = false;
  let replaceBeforeOwnerWrite = false;
  let failQuarantine = false;
  const deps: DirectoryLockDeps = {
    storage: {
      mkdirSync: (path: string) => {
        if (directories.has(path) || files.has(path)) {
          throw errno('EEXIST');
        }
        directories.set(path, now());
        directoryInodes.set(path, nextInode++);
      },
      writeFileSync: (path: string, data: unknown, options?: { readonly flag?: string }) => {
        const parent = dirname(path);
        if (!directories.has(parent)) {
          throw errno('ENOENT');
        }
        if (claimRefresh && path.includes('/claim-refresh-')) {
          claimRefresh = false;
          const mtime = fileMtimes.get(path) ?? now();
          files.delete(path);
          fileMtimes.delete(path);
          const claimant = `${parent}/claim-contender.lock`;
          files.add(claimant);
          fileMtimes.set(claimant, mtime);
        }
        if (options?.flag === 'r+' && !files.has(path)) {
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
        if (typeof data === 'string') fileContents.set(path, data);
      },
      readFileSync: (path: string) => {
        const content = fileContents.get(path);
        if (!files.has(path) || content === undefined) throw errno('ENOENT');
        return content;
      },
      renameSync: (oldPath: string, newPath: string) => {
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
          const content = fileContents.get(oldPath);
          fileContents.delete(oldPath);
          if (content !== undefined) fileContents.set(newPath, content);
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
            const content = fileContents.get(file);
            fileContents.delete(file);
            if (content !== undefined) fileContents.set(moved, content);
          }
        }
      },
      readdirSync: ((path: string) =>
        [...files]
          .filter((file) => dirname(file) === path)
          .map((file) => file.slice(path.length + 1))) as DirectoryLockDeps['storage']['readdirSync'],
      unlinkSync: (path: string) => {
        if (!files.delete(path)) {
          throw errno('ENOENT');
        }
        fileMtimes.delete(path);
        removed.push(path);
      },
      rmSync: (path: string) => {
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
      rmdirSync: (path: string) => {
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
      syncDirectoryDurableSync: () => true,
    } as unknown as DirectoryLockDeps['storage'],
    time: {
      now,
      monotonicNow,
      sleep: vi.fn(async () => {}),
      setInterval: vi.fn(() => ({})),
      clearInterval: vi.fn(),
    },
  };
  return {
    deps,
    directories,
    files,
    fileContents,
    removed,
    claimRefreshBeforeWrite: () => {
      claimRefresh = true;
    },
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

  it('backs every advertised lease actuator operation with its declared dependency shape', () => {
    const { deps } = createLockDeps(() => 1000);
    const release = acquireDirectoryLockSync('/locks/actuator-contract', deps, 100);

    expect(() => release.actuator.syncDirectory('/locks')).not.toThrow();

    release();
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

  it('loses ownership when a stale claimant moves the refresh marker before its write', () => {
    let currentTime = 0;
    const fixture = createLockDeps(() => currentTime);
    const staleOwner = acquireDirectoryLockSync('/locks/refresh-claim-race', fixture.deps, 100);
    currentTime = 31_000;
    fixture.claimRefreshBeforeWrite();

    expect(() => staleOwner.assertOwned()).toThrow(/ownership lost/u);
    expect([...fixture.files].some((path) => path.includes('/claim-contender.lock'))).toBe(true);

    const replacement = acquireDirectoryLockSync('/locks/refresh-claim-race', fixture.deps, 100);
    staleOwner();
    expect(fixture.directories.has('/locks/refresh-claim-race')).toBe(true);
    replacement();
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

  it('bounds a busy lock wait with monotonic time when wall time moves backward', async () => {
    let wallTime = 10_000;
    let monotonicTime = 0n;
    const fixture = createLockDeps(
      () => wallTime,
      () => {
        const observed = monotonicTime;
        monotonicTime += 50n;
        wallTime -= 1_000;
        return observed;
      },
    );
    fixture.directories.set('/locks/backward-wall-clock', wallTime);

    await expect(acquireDirectoryLock('/locks/backward-wall-clock', fixture.deps, 100)).rejects.toThrow(
      /Directory lock timeout/u,
    );
    expect(wallTime).toBeLessThan(10_000);
  });

  describe('owner liveness', () => {
    const HOLDER: DirectoryLockOwner = {
      pid: 4242,
      incarnation: processIncarnationSchema.parse('linux:boot:1'),
      pidNamespace: 'pid:[1]',
    };
    const CONTENDER: DirectoryLockOwner = { pid: 7, incarnation: null, pidNamespace: 'pid:[1]' };

    function ownerFixture(now: () => number = () => 1000): ReturnType<typeof createLockDeps> {
      let monotonic = 0n;
      return createLockDeps(now, () => (monotonic += 10n));
    }

    function holdAs(
      fixture: ReturnType<typeof createLockDeps>,
      lockDir: string,
      holder: DirectoryLockOwner,
    ): ReturnType<typeof acquireDirectoryLockSync> {
      return acquireDirectoryLockSync(
        lockDir,
        { ...fixture.deps, owner: { self: holder, observe: () => 'alive' } },
        100,
      );
    }

    function contend(
      fixture: ReturnType<typeof createLockDeps>,
      lockDir: string,
      holderLiveness: ProcessLiveness,
      contender: DirectoryLockOwner = CONTENDER,
    ): { acquire: () => ReturnType<typeof acquireDirectoryLockSync>; observed: unknown[] } {
      const observed: unknown[] = [];
      const deps: DirectoryLockDeps = {
        ...fixture.deps,
        owner: {
          self: contender,
          observe: (recorded) => {
            observed.push(recorded);
            return holderLiveness;
          },
        },
      };
      return { acquire: () => acquireDirectoryLockSync(lockDir, deps, 100), observed };
    }

    it('reclaims a lock whose recorded owner is proven gone without waiting for the stale window', () => {
      const fixture = ownerFixture();
      const killed = holdAs(fixture, '/locks/killed-holder', HOLDER);
      const { acquire, observed } = contend(fixture, '/locks/killed-holder', 'absent');

      const release = acquire();

      expect(observed[0]).toEqual({ pid: HOLDER.pid, incarnation: HOLDER.incarnation });
      expect(fixture.removed.some((path) => path.startsWith('/locks/killed-holder.stale-'))).toBe(true);
      expect(() => killed.assertOwned()).toThrow(/ownership lost/u);
      release();
    });

    it('keeps waiting on a live owner until the acquire deadline, as before', () => {
      const fixture = ownerFixture();
      const live = holdAs(fixture, '/locks/live-holder', HOLDER);

      expect(() => contend(fixture, '/locks/live-holder', 'alive').acquire()).toThrow(/Directory lock timeout/u);
      expect(() => live.assertOwned()).not.toThrow();
      live();
    });

    it('does not reclaim when the owner liveness is unknown', () => {
      const fixture = ownerFixture();
      const holder = holdAs(fixture, '/locks/unknown-holder', HOLDER);

      expect(() => contend(fixture, '/locks/unknown-holder', 'unknown').acquire()).toThrow(/Directory lock timeout/u);
      expect(() => holder.assertOwned()).not.toThrow();
      holder();
    });

    it('does not reclaim an owner recorded in another pid namespace, whose pid names nothing here', () => {
      const fixture = ownerFixture();
      const holder = holdAs(fixture, '/locks/foreign-namespace', HOLDER);
      const { acquire, observed } = contend(fixture, '/locks/foreign-namespace', 'absent', {
        ...CONTENDER,
        pidNamespace: 'pid:[2]',
      });

      expect(acquire).toThrow(/Directory lock timeout/u);
      expect(observed).toEqual([]);
      holder();
    });

    it('does not reclaim when this process cannot read its own pid namespace', () => {
      const fixture = ownerFixture();
      const holder = holdAs(fixture, '/locks/unreadable-namespace', HOLDER);
      const { acquire, observed } = contend(fixture, '/locks/unreadable-namespace', 'absent', {
        ...CONTENDER,
        pidNamespace: null,
      });

      expect(acquire).toThrow(/Directory lock timeout/u);
      expect(observed).toEqual([]);
      holder();
    });

    it('leaves a marker without an owner record to the time-based stale window', () => {
      let currentTime = 1000;
      const fixture = ownerFixture(() => currentTime);
      const holder = holdAs(fixture, '/locks/legacy-marker', HOLDER);
      const [marker] = [...fixture.files].filter((path) => path.startsWith('/locks/legacy-marker/owner-'));
      fixture.fileContents.set(marker, marker.slice('/locks/legacy-marker/owner-'.length, -'.lock'.length));
      const { acquire, observed } = contend(fixture, '/locks/legacy-marker', 'absent');

      expect(acquire).toThrow(/Directory lock timeout/u);
      expect(observed).toEqual([]);

      currentTime += 31_000;
      const release = acquire();
      expect(() => holder.assertOwned()).toThrow(/ownership lost/u);
      release();
    });
  });
});

describe('exclusive file lock wait', () => {
  const holders: ChildProcess[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      holders.splice(0).map(async (holder) => {
        if (holder.exitCode !== null || holder.signalCode !== null) return;
        const exited = once(holder, 'exit');
        holder.kill('SIGKILL');
        await exited;
      }),
    );
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** The wait blocks this thread, so only another process can release a holder during it. */
  async function sharedHolder(releaseAfterMs: number): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), 'coral-exclusive-wait-'));
    roots.push(root);
    const path = join(root, '.lock');
    writeFileSync(path, '');
    const holder = spawn(
      process.execPath,
      [
        '--no-warnings',
        '-e',
        `const { DatabaseSync } = require('node:sqlite');
         const db = new DatabaseSync(process.argv[1], { readOnly: true });
         db.exec('BEGIN; SELECT count(*) FROM sqlite_schema');
         process.stdout.write('held\\n');
         setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, Number(process.argv[2]));
         setInterval(() => {}, 1000);`,
        path,
        String(releaseAfterMs),
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    holders.push(holder);
    await new Promise<void>((resolve, reject) => {
      holder.once('exit', () => reject(new Error('Lock holder exited before holding.')));
      holder.stdout?.once('data', () => resolve());
    });
    return path;
  }

  it('should acquire a lock whose holder releases inside the busy timeout', async () => {
    const path = await sharedHolder(300);
    const attempt = attemptExclusiveFileLockSync(path, 5_000);
    expect(attempt.kind).toBe('acquired');
    if (attempt.kind === 'acquired') attempt.lease();
  });

  it('should refuse a lock whose holder outlasts the busy timeout', async () => {
    const path = await sharedHolder(60_000);
    expect(attemptExclusiveFileLockSync(path, 200).kind).toBe('contended');
  });
});

describe('malformed file lock repair', () => {
  const holders: ChildProcess[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      holders.splice(0).map(async (holder) => {
        if (holder.exitCode !== null || holder.signalCode !== null) return;
        const exited = once(holder, 'exit');
        holder.kill('SIGKILL');
        await exited;
      }),
    );
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function lockPath(): string {
    const root = mkdtempSync(join(tmpdir(), 'coral-lock-repair-'));
    roots.push(root);
    return join(root, 'namespace-supervisor.v1.lock');
  }

  function recreatedAndAcquired(path: string): boolean {
    createSharedFileLockSync(path)();
    const attempt = attemptExclusiveFileLockSync(path);
    if (attempt.kind === 'acquired') attempt.lease();
    return attempt.kind === 'acquired';
  }

  it('should move aside a lock file whose bytes no process can lock, and let the address be locked again', () => {
    const path = lockPath();
    writeFileSync(path, 'not a sqlite database, and long enough to have a header to reject');
    expect(attemptExclusiveFileLockSync(path).kind).toBe('malformed');

    const repair = repairMalformedFileLockSync(path);

    expect(repair.kind).toBe('moved-aside');
    if (repair.kind === 'moved-aside') expect(readFileSync(repair.quarantinePath, 'utf8')).toContain('not a sqlite');
    expect(recreatedAndAcquired(path)).toBe(true);
  });

  it('should move aside a directory standing at the lock address', () => {
    const path = lockPath();
    mkdirSync(path);

    expect(repairMalformedFileLockSync(path).kind).toBe('moved-aside');
    expect(recreatedAndAcquired(path)).toBe(true);
  });

  it('should move aside a second link only while holding its lock', () => {
    const path = lockPath();
    createSharedFileLockSync(path)();
    linkSync(path, `${path}.alias`);
    expect(attemptExclusiveFileLockSync(path).kind).toBe('malformed');

    expect(repairMalformedFileLockSync(path).kind).toBe('moved-aside');
    expect(recreatedAndAcquired(path)).toBe(true);
  });

  it('should leave a lock file in place while another process holds it, however its bytes read', async () => {
    const path = lockPath();
    createSharedFileLockSync(path)();
    const holder = spawn(
      process.execPath,
      [
        '--no-warnings',
        '-e',
        `const { DatabaseSync } = require('node:sqlite');
         const db = new DatabaseSync(process.argv[1]);
         db.exec('BEGIN EXCLUSIVE');
         process.stdout.write('held\\n');
         setInterval(() => {}, 1000);`,
        path,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    holders.push(holder);
    await new Promise<void>((resolve, reject) => {
      holder.once('exit', () => reject(new Error('Lock holder exited before holding.')));
      holder.stdout?.once('data', () => resolve());
    });
    const inode = statSync(path).ino;
    writeFileSync(path, 'bytes written over a held lock file');
    linkSync(path, `${path}.alias`);

    expect(repairMalformedFileLockSync(path)).toEqual({ kind: 'held' });
    expect(statSync(path).ino).toBe(inode);
  });

  it('should defer to a repair already in progress', () => {
    const path = lockPath();
    mkdirSync(path);
    const inProgress = acquireDirectoryLockSync(`${path}.repair`);
    try {
      expect(repairMalformedFileLockSync(path)).toEqual({ kind: 'repair-in-progress' });
      expect(statSync(path).isDirectory()).toBe(true);
    } finally {
      inProgress();
    }
  });
});
