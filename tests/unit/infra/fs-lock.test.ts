import * as fs from 'node:fs';
import { createRealRuntime } from '#src/runtime/real.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireDirectoryLock, acquireDirectoryLockSync, type DirectoryLockDeps } from '#src/infra/fs-lock.js';

let root: string;
let wallTime: number;
let elapsed: bigint;
let deps: DirectoryLockDeps;

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'coral-fs-lock-'));
  wallTime = Date.now();
  elapsed = 0n;
  deps = {
    storage: {
      ...createRealRuntime('prod', { baseDir: root }).storage,
      writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
        fs.writeFileSync(...args);
        fs.utimesSync(args[0] as string, new Date(wallTime), new Date(wallTime));
      },
      syncDirectoryDurableSync: () => true,
    },
    time: {
      now: () => wallTime,
      monotonicNow: () => elapsed,
      sleep: async (ms) => {
        elapsed += BigInt(ms);
      },
      setInterval: () => ({}),
      clearInterval: () => {},
    },
  };
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('directory fs lock', () => {
  it('prevents an old owner from releasing its replacement', () => {
    const path = join(root, 'lock');
    const oldOwner = acquireDirectoryLockSync(path, deps, 100);
    wallTime += 31_000;
    const replacement = acquireDirectoryLockSync(path, deps, 100);

    expect(() => oldOwner.assertOwned()).toThrow(/ownership lost/u);
    oldOwner();
    expect(() => replacement.assertOwned()).not.toThrow();
    expect(fs.existsSync(path)).toBe(true);
    replacement();
    expect(fs.existsSync(path)).toBe(false);
  });

  it('recovers a stale claim left by a crashed contender', () => {
    const path = join(root, 'lock');
    fs.mkdirSync(path);
    const claim = join(path, 'claim-crashed.lock');
    fs.writeFileSync(claim, 'crashed');
    const stale = new Date(wallTime - 31_000);
    fs.utimesSync(claim, stale, stale);
    fs.utimesSync(path, stale, stale);

    const release = acquireDirectoryLockSync(path, deps, 100);
    expect(() => release.assertOwned()).not.toThrow();
    expect(fs.readdirSync(path)).not.toContain('claim-crashed.lock');
    release();
    expect(fs.existsSync(path)).toBe(false);
  });

  it('aborts a wait without removing the held lock', async () => {
    const path = join(root, 'lock');
    const release = acquireDirectoryLockSync(path, deps, 100);
    const controller = new AbortController();
    deps.time.sleep = () => new Promise<void>(() => {});
    const waiting = acquireDirectoryLock(path, { ...deps, signal: controller.signal }, 10_000);
    const reason = new Error('stop waiting');
    controller.abort(reason);

    await expect(waiting).rejects.toBe(reason);
    expect(() => release.assertOwned()).not.toThrow();
    release();
  });

  it('bounds a busy wait even when wall time moves backward', async () => {
    const path = join(root, 'lock');
    const release = acquireDirectoryLockSync(path, deps, 100);
    deps.time.sleep = async (ms) => {
      elapsed += BigInt(ms);
      wallTime -= 1_000;
    };

    await expect(acquireDirectoryLock(path, deps, 100)).rejects.toThrow(/Directory lock timeout/u);
    expect(elapsed).toBe(100n);
    expect(fs.existsSync(path)).toBe(true);
    release();
  });
});
