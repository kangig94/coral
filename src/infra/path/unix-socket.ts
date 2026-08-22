import { join } from 'node:path';

const SOCKET_LIMIT_CONSERVATIVE = 104;
const SOCKET_LIMIT_LINUX = 108;

export function socketPathByteLimit(platformName: string): number {
  switch (platformName) {
    case 'linux':
      return SOCKET_LIMIT_LINUX;
    case 'darwin':
    case 'freebsd':
    case 'openbsd':
    default:
      return SOCKET_LIMIT_CONSERVATIVE;
  }
}

/**
 * Where a socket path that overflows `sun_path` relocates to. It may not be read from the environment:
 * moving a socket moves ownership, and two processes over one state root that disagree about the address
 * both find their own unbound and both bind.
 */
const SOCKET_FALLBACK_ROOT = '/tmp';
const SOCKET_FALLBACK_PREFIX = join(SOCKET_FALLBACK_ROOT, 'coral-');

export function socketFallbackDir(uid: number): string {
  return join(SOCKET_FALLBACK_ROOT, `coral-${uid}`);
}

export function socketFallbackUid(socketDirectory: string): number | undefined {
  if (!socketDirectory.startsWith(SOCKET_FALLBACK_PREFIX)) return undefined;

  const uid = Number(socketDirectory.slice(SOCKET_FALLBACK_PREFIX.length));
  return socketDirectory === socketFallbackDir(uid) ? uid : undefined;
}

export function isRelocatedSocket(socketDirectory: string): boolean {
  return socketFallbackUid(socketDirectory) !== undefined;
}
