import { join } from 'node:path';

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

export function socketFallbackDir(uid: number): string {
  return join(SOCKET_FALLBACK_ROOT, `coral-${uid}`);
}

export function isRelocatedSocket(socketDirectory: string, uid: number): boolean {
  return socketDirectory === socketFallbackDir(uid);
}
