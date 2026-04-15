import { describe, expect, it, vi } from 'vitest';
import {
  acquireDirectoryLockSync,
  type DirectoryLockDeps,
} from '../fs-lock.js';

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function createLockDeps(now: () => number): {
  deps: DirectoryLockDeps;
  directories: Map<string, number>;
  removed: string[];
} {
  const directories = new Map<string, number>();
  const removed: string[] = [];
  const deps: DirectoryLockDeps = {
    storage: {
      mkdirSync: (path) => {
        if (directories.has(path)) {
          throw errno('EEXIST');
        }
        directories.set(path, now());
      },
      rmSync: (path) => {
        removed.push(path);
        directories.delete(path);
      },
      statSync: (path) => {
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
      },
    },
    time: {
      now,
      sleep: vi.fn(async () => {}),
    },
  };
  return { deps, directories, removed };
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
    expect(removed).toEqual(['/locks/session-1']);
  });

  it('uses explicit sync deps for stale lock checks and removal', () => {
    const { deps, directories, removed } = createLockDeps(() => 31_000);
    directories.set('/locks/stale-session', 0);

    const release = acquireDirectoryLockSync('/locks/stale-session', deps, 100);

    expect(directories.has('/locks/stale-session')).toBe(true);
    expect(removed).toEqual(['/locks/stale-session']);
    release();
    expect(removed).toEqual(['/locks/stale-session', '/locks/stale-session']);
  });
});
