import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensurePrivateSocketDir, SocketDirectoryError } from '#src/infra/private-socket-directory.js';

const CURRENT_UID = process.getuid?.() ?? 0;
const roots: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-private-socket-dir-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const realStorage = { chmodSync, lstatSync, mkdirSync };

describe('ensurePrivateSocketDir', () => {
  it('creates a missing directory at mode 0700', () => {
    const directory = join(scratch(), 'fallback');

    ensurePrivateSocketDir(directory, CURRENT_UID, realStorage);

    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  });

  it('tightens a directory of its own that another umask left loose', () => {
    const directory = join(scratch(), 'loose');
    mkdirSync(directory, { mode: 0o755 });
    chmodSync(directory, 0o755);

    ensurePrivateSocketDir(directory, CURRENT_UID, realStorage);

    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  });

  it('refuses a symlink without following it', () => {
    const root = scratch();
    const target = join(root, 'target');
    const directory = join(root, 'link');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, directory);

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, realStorage)).toThrowError(
      expect.objectContaining({ name: 'SocketDirectoryError', refusal: 'foreign' }),
    );
  });

  it('refuses a path it cannot create as a directory', () => {
    const directory = join(scratch(), 'regular');
    writeFileSync(directory, '');

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, realStorage)).toThrowError(
      expect.objectContaining({ refusal: 'unverified' }),
    );
  });

  it('refuses a directory owned by another uid as foreign', () => {
    const directory = join(scratch(), 'foreign');
    mkdirSync(directory, { mode: 0o700 });

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID + 1, realStorage)).toThrowError(
      expect.objectContaining({ refusal: 'foreign' }),
    );
  });

  it('separates an observation it could not make from one that decided', () => {
    const directory = join(scratch(), 'unobservable');
    const failing = {
      ...realStorage,
      lstatSync: () => {
        throw new Error('EIO: i/o error, lstat');
      },
    };

    try {
      ensurePrivateSocketDir(directory, CURRENT_UID, failing);
      expect.unreachable('an unobservable directory must not be accepted');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(SocketDirectoryError);
      expect((error as SocketDirectoryError).refusal).toBe('unverified');
      expect((error as SocketDirectoryError).message).toContain('could not be verified');
    }
  });

  it('refuses a uid it cannot use as an owner', () => {
    const directory = join(scratch(), 'nan-uid');

    expect(() => ensurePrivateSocketDir(directory, Number.NaN, realStorage)).toThrowError(
      expect.objectContaining({ refusal: 'unverified' }),
    );
  });
});
