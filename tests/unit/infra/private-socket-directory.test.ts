import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { StorageBigIntStat } from '#src/infra/port-types.js';
import {
  ensurePrivateSocketDir,
  SocketDirectoryError,
  type SocketDirectoryStorage,
} from '#src/infra/private-socket-directory.js';

const CURRENT_UID = process.getuid?.() ?? 0;
const FILE_TYPE_BITS = 0o170000n;
const DIRECTORY_TYPE = 0o040000n;
const REGULAR_FILE_TYPE = 0o100000n;
const roots: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'coral-socket-dir-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const realStorage = { chmodSync, lstatSync, mkdirSync, statSync };

interface SupportedStatSync {
  (path: string, options?: undefined): Stats;
  (path: string, options: { bigint: true }): StorageBigIntStat;
}

function overrideBigIntStat(
  read: SupportedStatSync,
  overrides: Partial<Pick<StorageBigIntStat, 'mode' | 'uid'>>,
): SupportedStatSync {
  function overridden(path: string, options?: undefined): Stats;
  function overridden(path: string, options: { bigint: true }): StorageBigIntStat;
  function overridden(path: string, options?: { bigint: true }): Stats | StorageBigIntStat {
    if (options === undefined) {
      return read(path, options);
    }
    const observed = read(path, options);
    const mode = overrides.mode ?? observed.mode;
    return {
      ...observed,
      ...overrides,
      mode,
      isDirectory: () => (mode & FILE_TYPE_BITS) === DIRECTORY_TYPE,
      isFile: () => (mode & FILE_TYPE_BITS) === REGULAR_FILE_TYPE,
    };
  }
  return overridden;
}

function storageReportingParentUid(uid: bigint | undefined): SocketDirectoryStorage {
  return {
    ...realStorage,
    statSync: overrideBigIntStat(statSync, { uid }),
  };
}

function scratchDirectory(mode: number): string {
  const root = scratch();
  chmodSync(root, mode);
  return join(root, 'fallback');
}

describe('ensurePrivateSocketDir', () => {
  it('creates a missing directory at mode 0700', () => {
    const directory = join(scratch(), 'fallback');

    ensurePrivateSocketDir(directory, CURRENT_UID, realStorage);

    expect(lstatSync(directory).mode & 0o7777).toBe(0o700);
  });

  it('tightens a directory of its own that another umask left loose', () => {
    const directory = join(scratch(), 'loose');
    mkdirSync(directory, { mode: 0o755 });
    chmodSync(directory, 0o755);

    ensurePrivateSocketDir(directory, CURRENT_UID, realStorage);

    expect(lstatSync(directory).mode & 0o7777).toBe(0o700);
  });

  it('refuses a symlink to a directory that would otherwise pass, without following it', () => {
    const root = scratch();
    const target = join(root, 'target');
    const directory = join(root, 'link');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, directory);

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, realStorage)).toThrowError(
      expect.objectContaining({ name: 'SocketDirectoryError', refusal: 'unusable' }),
    );
  });

  it('refuses a path of its own that is not a directory', () => {
    const directory = join(scratch(), 'regular');
    writeFileSync(directory, '');

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, realStorage)).toThrowError(
      expect.objectContaining({ refusal: 'unusable' }),
    );
  });

  it('refuses a directory owned by another uid as foreign', () => {
    const directory = join(scratch(), 'foreign');
    mkdirSync(directory, { mode: 0o700 });
    const foreignEntry = {
      ...realStorage,
      lstatSync: overrideBigIntStat(lstatSync, { uid: BigInt(CURRENT_UID) + 1n }),
    };

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, foreignEntry)).toThrowError(
      expect.objectContaining({ refusal: 'foreign' }),
    );
  });

  it('keeps a foreign regular file classified as foreign', () => {
    const directory = join(scratch(), 'foreign-file');
    writeFileSync(directory, '');
    const storage = {
      ...realStorage,
      lstatSync: overrideBigIntStat(lstatSync, { uid: BigInt(CURRENT_UID) + 1n }),
    };

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, storage)).toThrowError(
      expect.objectContaining({ refusal: 'foreign' }),
    );
  });

  it('wraps a failed parent observation as unverified', () => {
    const directory = join(scratch(), 'parent-read-error');
    const failing = {
      ...realStorage,
      statSync: () => {
        throw new Error('EIO: i/o error, stat parent');
      },
    };

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, failing)).toThrowError(
      expect.objectContaining({
        refusal: 'unverified',
        detail: 'EIO: i/o error, stat parent',
      }),
    );
  });

  it('reports the mkdir failure when creation and its readback both fail', () => {
    const directory = join(scratch(), 'create-and-read-error');
    const failing = {
      ...realStorage,
      mkdirSync: () => {
        throw new Error('EROFS: read-only file system, mkdir');
      },
      lstatSync: () => {
        throw new Error('EIO: i/o error, lstat after mkdir');
      },
    };

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, failing)).toThrowError(
      expect.objectContaining({
        refusal: 'unverified',
        detail: 'EROFS: read-only file system, mkdir',
      }),
    );
  });

  it('accepts a secure matching directory observed after its create reports failure', () => {
    const directory = join(scratch(), 'created-despite-error');
    mkdirSync(directory, { mode: 0o700 });
    const storage = {
      ...realStorage,
      mkdirSync: () => {
        throw new Error('EIO: create result unavailable');
      },
    };

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, storage)).not.toThrow();
    expect(lstatSync(directory).mode & 0o7777).toBe(0o700);
  });

  it('reports an entry it could not observe as unverified', () => {
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

  it.each([
    ['an Error', new Error('real'), 'real'],
    ['an Error subclass', new TypeError('wrong type'), 'wrong type'],
    ['an Error with no message', new Error(''), 'the storage adapter threw without an observation'],
    ['an errno-like object with a code', { code: 'EIO' }, 'EIO'],
    ['an errno-like object with a message', { message: 'adapter offline' }, 'adapter offline'],
    ['a plain object', { operation: 'lstat' }, 'the storage adapter threw without an observation'],
    ['a string', 'EIO primitive', 'EIO primitive'],
    ['an empty string', '', 'the storage adapter threw without an observation'],
    ['a whitespace-only string', '   ', 'the storage adapter threw without an observation'],
    ['a number', 17, '17'],
    ['a bigint', 17n, '17'],
    ['a boolean', false, 'false'],
    ['null', null, 'the storage adapter threw without an observation'],
    ['no observation', undefined, 'the storage adapter threw without an observation'],
    ['a symbol', Symbol('EIO'), 'Symbol(EIO)'],
    ['an array', ['EIO'], 'the storage adapter threw without an observation'],
    ['a function', () => undefined, 'the storage adapter threw without an observation'],
  ])('renders %s thrown by a storage adapter', (_label, thrown, expectedDetail) => {
    const directory = join(scratch(), 'adapter-error');
    const failing = {
      ...realStorage,
      lstatSync: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Unknown adapter failures must retain primitive observations.
        throw thrown;
      },
    };

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, failing)).toThrowError(
      expect.objectContaining({
        refusal: 'unverified',
        detail: expectedDetail,
        message: expect.stringContaining(expectedDetail),
      }),
    );
    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, failing)).toThrowError(
      expect.not.objectContaining({ message: expect.stringContaining('undefined') }),
    );
  });

  it.each([
    ['world-writable', 0o777],
    // A group another user belongs to can rename our entry exactly as `other` can, so a check that reads
    // only the `other` bits does not establish the property its refusal claims.
    ['group-writable', 0o770],
  ])('refuses a %s parent that lets another user replace the entry it just checked', (_label, mode) => {
    const directory = scratchDirectory(mode);

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, realStorage)).toThrowError(
      expect.objectContaining({ refusal: 'unsecurable', detail: expect.stringContaining('writable by other users') }),
    );
  });

  it('accepts a world-writable parent of its own that keeps the restricted-deletion bit', () => {
    const directory = scratchDirectory(0o1777);

    ensurePrivateSocketDir(directory, CURRENT_UID, realStorage);

    expect(lstatSync(directory).mode & 0o7777).toBe(0o700);
  });

  it('accepts the root-owned sticky parent used by production /tmp', () => {
    const directory = scratchDirectory(0o1777);
    const uid = CURRENT_UID === 0 ? 1 : CURRENT_UID;
    const rootOwnedParent = {
      ...storageReportingParentUid(0n),
      lstatSync: overrideBigIntStat(lstatSync, { uid: BigInt(uid) }),
    };

    ensurePrivateSocketDir(directory, uid, rootOwnedParent);

    expect(lstatSync(directory).mode & 0o7777).toBe(0o700);
  });

  it.each([
    ['0755', 0o755],
    ['0700', 0o700],
  ])('refuses a foreign-owned parent with mode %s', (_label, mode) => {
    const directory = scratchDirectory(mode);
    const foreignUid = BigInt(CURRENT_UID) + 1n;

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, storageReportingParentUid(foreignUid))).toThrowError(
      expect.objectContaining({
        refusal: 'unsecurable',
        detail: expect.stringContaining(`belongs to uid ${foreignUid}`),
      }),
    );
  });

  it('leaves a parent with no reported owner unverified', () => {
    const directory = scratchDirectory(0o700);

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, storageReportingParentUid(undefined))).toThrowError(
      expect.objectContaining({
        refusal: 'unverified',
        detail: expect.stringContaining(`'${dirname(directory)}' reported no owner`),
      }),
    );
  });

  it('refuses a non-directory parent even when it reports no owner', () => {
    const directory = scratchDirectory(0o700);
    const storage = {
      ...realStorage,
      statSync: overrideBigIntStat(statSync, { uid: undefined, mode: 0o100700n }),
    };

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, storage)).toThrowError(
      expect.objectContaining({ refusal: 'unsecurable', detail: expect.stringContaining('is not a directory') }),
    );
  });

  it('leaves an entry with no reported owner unverified', () => {
    const directory = join(scratch(), 'unowned-entry');
    const unownedEntry = {
      ...realStorage,
      lstatSync: overrideBigIntStat(lstatSync, { uid: undefined }),
    };

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, unownedEntry)).toThrowError(
      expect.objectContaining({
        refusal: 'unverified',
        detail: 'the directory reported no owner',
      }),
    );
  });

  it('refuses a non-directory entry even when it reports no owner', () => {
    const directory = join(scratch(), 'unowned-file');
    const storage = {
      ...realStorage,
      lstatSync: overrideBigIntStat(lstatSync, { uid: undefined, mode: 0o100700n }),
    };

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, storage)).toThrowError(
      expect.objectContaining({ refusal: 'unusable' }),
    );
  });

  it('refuses a restricted-deletion parent belonging to someone else, which that owner is exempt from', () => {
    const directory = scratchDirectory(0o1777);

    expect(() =>
      ensurePrivateSocketDir(directory, CURRENT_UID, storageReportingParentUid(BigInt(CURRENT_UID) + 1n)),
    ).toThrowError(
      expect.objectContaining({ refusal: 'unsecurable', detail: expect.stringContaining('belongs to uid') }),
    );
  });

  it('refuses a filesystem that accepts the mode change and keeps its own permissions', () => {
    const directory = join(scratch(), 'immutable-mode');
    const stubborn = {
      ...realStorage,
      chmodSync: () => undefined,
      lstatSync: overrideBigIntStat(lstatSync, { mode: 0o40755n }),
    };

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, stubborn)).toThrowError(
      expect.objectContaining({ refusal: 'unsecurable', detail: expect.stringContaining('kept its own permissions') }),
    );
  });

  it('uses the readback verdict when chmod fails but the directory remains observable', () => {
    const directory = join(scratch(), 'read-only-mode');
    mkdirSync(directory, { mode: 0o755 });
    chmodSync(directory, 0o755);
    const readOnly = {
      ...realStorage,
      chmodSync: () => {
        throw new Error('EROFS: read-only file system, chmod');
      },
    };

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, readOnly)).toThrowError(
      expect.objectContaining({
        refusal: 'unsecurable',
        detail: expect.stringMatching(/EROFS: read-only file system, chmod.*040755/u),
      }),
    );
  });

  it('accepts an exact private readback after chmod reports failure', () => {
    const directory = join(scratch(), 'completed-chmod');
    mkdirSync(directory, { mode: 0o755 });
    chmodSync(directory, 0o755);
    const storage = {
      ...realStorage,
      chmodSync: (path: string, mode: number) => {
        chmodSync(path, mode);
        throw new Error('EIO: chmod result unavailable');
      },
    };

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, storage)).not.toThrow();
    expect(lstatSync(directory).mode & 0o7777).toBe(0o700);
  });

  it('reports the chmod failure when tightening and its readback both fail', () => {
    const directory = join(scratch(), 'chmod-and-read-error');
    mkdirSync(directory, { mode: 0o755 });
    chmodSync(directory, 0o755);
    let lstatCalls = 0;
    const failing = {
      ...realStorage,
      chmodSync: () => {
        throw new Error('EROFS: read-only file system, chmod');
      },
      lstatSync: (path: string, options: { bigint: true }) => {
        lstatCalls += 1;
        if (lstatCalls === 1) return lstatSync(path, options);
        throw new Error('EIO: i/o error, lstat after chmod');
      },
    };

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, failing)).toThrowError(
      expect.objectContaining({
        refusal: 'unverified',
        detail: 'EROFS: read-only file system, chmod',
      }),
    );
  });

  it.each([
    ['foreign directory', { uid: BigInt(CURRENT_UID) + 1n, mode: 0o40700n }, 'foreign'],
    ['regular file', { uid: BigInt(CURRENT_UID), mode: 0o100600n }, 'unusable'],
  ] as const)('uses the final readback when the entry becomes a %s', (_label, replacement, refusal) => {
    const directory = join(scratch(), 'replaced-after-chmod');
    mkdirSync(directory, { mode: 0o755 });
    chmodSync(directory, 0o755);
    let lstatCalls = 0;
    const replacementRead = overrideBigIntStat(lstatSync, replacement);
    const storage: SocketDirectoryStorage = {
      ...realStorage,
      chmodSync: () => undefined,
      lstatSync: (path, options) => {
        lstatCalls += 1;
        return lstatCalls === 1 ? lstatSync(path, options) : replacementRead(path, options);
      },
    };

    expect(() => ensurePrivateSocketDir(directory, CURRENT_UID, storage)).toThrowError(
      expect.objectContaining({ refusal }),
    );
  });

  // `/tmp` is a symlink on macOS, and a link's own mode decides nothing about who may write in the directory
  // it names — on Linux every symlink reads `0777`, which a non-following parent read would refuse outright.
  it('reads the parent through the link rather than reading the link', () => {
    const root = scratch();
    const real = join(root, 'real-parent');
    const link = join(root, 'linked-parent');
    mkdirSync(real, { mode: 0o700 });
    chmodSync(real, 0o700);
    symlinkSync(real, link);
    const directory = join(link, 'fallback');

    ensurePrivateSocketDir(directory, CURRENT_UID, realStorage);

    expect(lstatSync(directory).mode & 0o7777).toBe(0o700);
  });

  // Ownership and permission bits say nothing about what the entry is; a create against a regular file
  // fails ENOTDIR, which is a decided condition and not an unobserved one.
  it('refuses a parent of its own that is not a directory', () => {
    const root = scratch();
    const parent = join(root, 'regular-parent');
    writeFileSync(parent, '');
    chmodSync(parent, 0o700);

    expect(() => ensurePrivateSocketDir(join(parent, 'fallback'), CURRENT_UID, realStorage)).toThrowError(
      expect.objectContaining({ refusal: 'unsecurable', detail: expect.stringContaining('is not a directory') }),
    );
  });

  // "mode 0700" is twelve bits: a set-id or sticky bit on a directory of ours is not the mode this asks for,
  // and a check reading only the access bits cannot see it.
  it.each([
    ['sticky', 0o1700],
    ['setgid', 0o2700],
    ['setuid', 0o4700],
  ])('tightens a directory of its own carrying the %s bit', (_label, mode) => {
    const directory = join(scratch(), 'high-bit');
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, mode);

    ensurePrivateSocketDir(directory, CURRENT_UID, realStorage);

    expect(lstatSync(directory).mode & 0o7777).toBe(0o700);
  });

  // A trailing separator makes `lstat` follow, so the read this module calls non-following is only
  // non-following once the argument is canonical.
  it('canonicalises before the non-following read', () => {
    const root = scratch();
    const target = join(root, 'target');
    const link = join(root, 'link');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, link);

    expect(() => ensurePrivateSocketDir(`${link}/`, CURRENT_UID, realStorage)).toThrowError(
      expect.objectContaining({ refusal: 'unusable' }),
    );
  });

  // An entry the create could not make but the read can name is a decided observation, not an unobserved
  // one: a dangling link fails `ENOENT` where an occupied path fails `EEXIST`.
  it('names a dangling link rather than reporting the create that could not pass it', () => {
    const root = scratch();
    const link = join(root, 'fallback');
    symlinkSync(join(root, 'absent'), link);

    expect(() => ensurePrivateSocketDir(link, CURRENT_UID, realStorage)).toThrowError(
      expect.objectContaining({ refusal: 'unusable' }),
    );
  });

  it('refuses a uid it cannot use as an owner', () => {
    const directory = join(scratch(), 'nan-uid');

    expect(() => ensurePrivateSocketDir(directory, Number.NaN, realStorage)).toThrowError(
      expect.objectContaining({
        refusal: 'unverified',
        detail: 'the owner uid named by the socket address is not usable',
      }),
    );
  });
});
