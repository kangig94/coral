import { dirname, join } from 'node:path';

const SOCKET_LIMIT_DARWIN = 104;
const SOCKET_LIMIT_LINUX = 108;

export function socketPathByteLimit(platformName: string): number {
  return platformName === 'darwin' ? SOCKET_LIMIT_DARWIN : SOCKET_LIMIT_LINUX;
}

/**
 * Where a socket path that overflows `sun_path` relocates to. It may not be read from the environment:
 * moving a socket moves ownership, and two processes over one state root that disagree about the address
 * both find their own unbound and both bind.
 */
const SOCKET_FALLBACK_ROOT = '/tmp';

/** 64 bits, because under a fixed root every overflowing state root on the host draws from one namespace. */
export const SOCKET_FALLBACK_HASH_LENGTH = 16;

export function socketFallbackDir(uid: number): string {
  return join(SOCKET_FALLBACK_ROOT, `coral-${uid}`);
}

/**
 * Whether this socket is one this build relocated. The parent must be exactly the shared per-uid directory,
 * not merely somewhere under the shared root: a run directory lives inside the caller's own state root, and a
 * socket a test or an operator placed elsewhere under the root is not this build's to hold to a mode.
 */
export function isRelocatedSocket(socketPath: string, uid: number): boolean {
  return dirname(socketPath) === socketFallbackDir(uid);
}
