import { lstatSync, mkdtempSync, rmSync, statfsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { testTempEnv, testTempRoot, userRootName } from '../../../vitest/temp-root.js';

const TMPFS_MAGIC = 0x01021994;

function shmIsUsableTmpfs(): boolean {
  try {
    const stats = statfsSync('/dev/shm');
    return stats.type === TMPFS_MAGIC && stats.bavail * stats.bsize >= 1024 * 1024 * 1024;
  } catch {
    return false;
  }
}

const created: string[] = [];

function expectedUserRoot(base: string): string {
  return join(base, userRootName());
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('test temp root', () => {
  it('falls back to the platform temp directory when no candidate is a usable tmpfs', () => {
    expect(testTempRoot(['/nonexistent-candidate', undefined])).toBe(tmpdir());
  });

  it('falls back when a candidate exists and is writable but is not memory-backed', () => {
    // Stands in for a CI image with no /dev/shm at all: the repository checkout is on the same on-disk
    // filesystem every candidate has to be distinguished from.
    expect(testTempRoot([process.cwd()])).toBe(tmpdir());
  });

  it('honours an explicit override ahead of every candidate', () => {
    const override = mkdtempSync(join(tmpdir(), 'coral-temp-root-override-'));
    created.push(override);
    vi.stubEnv('CORAL_TEST_TMPDIR', override);

    const root = testTempRoot(['/dev/shm']);
    expect(root).toBe(expectedUserRoot(override));
    const stats = lstatSync(root);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o700);
    if (process.getuid !== undefined) expect(stats.uid).toBe(process.getuid());
  });

  it.runIf(process.platform !== 'win32')('falls back when the per-user root is an existing symlink', () => {
    const override = mkdtempSync(join(tmpdir(), 'coral-temp-root-symlink-'));
    created.push(override);
    const target = mkdtempSync(join(override, 'target-'));
    symlinkSync(target, expectedUserRoot(override), 'dir');
    vi.stubEnv('CORAL_TEST_TMPDIR', override);

    expect(testTempRoot()).toBe(tmpdir());
  });

  it('publishes one root under every name a temp-directory lookup consults', () => {
    const env = testTempEnv();

    expect(new Set(Object.values(env)).size).toBe(1);
    expect(Object.keys(env).sort()).toEqual(['TEMP', 'TMP', 'TMPDIR']);
  });

  it.runIf(shmIsUsableTmpfs() && testTempRoot(['/dev/shm']) !== tmpdir())(
    'prefers a usable executable memory-backed root over the platform temp directory',
    () => {
      expect(testTempRoot()).toBe(expectedUserRoot('/dev/shm'));
    },
  );
});
