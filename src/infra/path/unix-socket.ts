import { dirname, join } from 'node:path';

import type { StorageBigIntStat, StoragePort } from '../port-types.js';

const SOCKET_LIMIT_DARWIN = 104;
const SOCKET_LIMIT_LINUX = 108;

const PRIVATE_DIRECTORY_MODE = 0o700n;
const PERMISSION_BITS = 0o777n;

export function socketPathByteLimit(platformName: string): number {
  return platformName === 'darwin' ? SOCKET_LIMIT_DARWIN : SOCKET_LIMIT_LINUX;
}

/**
 * Where a socket path that overflows `sun_path` relocates to. A literal rather than `TMPDIR` or
 * `os.tmpdir()`: moving a socket moves ownership, and two processes over one state root that disagree
 * about the address both find their own unbound and both bind.
 */
const SOCKET_FALLBACK_ROOT = '/tmp';

/** 64 bits. Under a fixed root every overflowing state root on the host draws from one namespace. */
export const SOCKET_FALLBACK_HASH_LENGTH = 16;

export function socketFallbackDir(uid: number): string {
  return join(SOCKET_FALLBACK_ROOT, `coral-${uid}`);
}

/**
 * Whether this socket is one this build relocated — its parent is exactly the shared per-uid directory,
 * not merely somewhere under the shared root. Only that directory gets its mode asserted: a run directory
 * lives inside the caller's own state root, and a socket a test or an operator placed elsewhere under the
 * root is not this build's to hold to a mode.
 */
export function isRelocatedSocket(socketPath: string, uid: number): boolean {
  return dirname(socketPath) === socketFallbackDir(uid);
}

type SocketDirectoryStorage = Pick<StoragePort, 'lstatSync' | 'mkdirSync'> & {
  statSync(path: string, options: { bigint: true }): StorageBigIntStat;
};

export class SocketDirectoryError extends Error {
  readonly directory: string;
  readonly uid: number;

  // An I/O failure has established nothing about ownership or mode, so it must not be reported as though
  // it had: an operator told to check permissions will go and check permissions.
  constructor(directory: string, uid: number, cause?: unknown) {
    const reason =
      cause === undefined
        ? `must be a uid-${uid} directory with mode 0700`
        : `could not be verified as a uid-${uid} directory with mode 0700: ${cause instanceof Error ? cause.message : 'unknown cause'}`;
    super(`Socket directory '${directory}' ${reason}.`, { cause });
    this.name = 'SocketDirectoryError';
    this.directory = directory;
    this.uid = uid;
  }
}

/**
 * Creates the directory `0700` and refuses unless it is a non-symlink directory owned by `uid` at exactly
 * that mode. A recursive create does not tighten a directory that already exists, so an existing one that
 * another process made under its umask must be refused rather than trusted — every caller that binds
 * under `SOCKET_FALLBACK_ROOT` shares one address there, and the socket is the singleton lock.
 */
export function ensurePrivateSocketDir(directory: string, uid: number, storage: SocketDirectoryStorage): void {
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new SocketDirectoryError(directory, uid);
  }

  try {
    storage.mkdirSync(directory, { recursive: true, mode: Number(PRIVATE_DIRECTORY_MODE) });
    const link = storage.lstatSync(directory);
    const stat = storage.statSync(directory, { bigint: true });
    if (
      !link.isDirectory() ||
      link.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.uid === undefined ||
      stat.uid !== BigInt(uid) ||
      (stat.mode & PERMISSION_BITS) !== PRIVATE_DIRECTORY_MODE
    ) {
      throw new SocketDirectoryError(directory, uid);
    }
  } catch (error: unknown) {
    if (error instanceof SocketDirectoryError) throw error;
    throw new SocketDirectoryError(directory, uid, error);
  }
}
