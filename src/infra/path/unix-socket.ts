import { join } from 'node:path';

import { hashToken } from '../hash.js';

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

/** The fallback root may not be read from the environment: moving a socket moves ownership, and two
 * processes over one state root that disagree about the address both find their own unbound and both bind. */
const SOCKET_FALLBACK_ROOT = '/tmp';
const SOCKET_FALLBACK_NAMESPACE_HASH_LENGTH = 16;
const SOCKET_FALLBACK_DIRECTORY_PATTERN = /^coral-[0-9a-f]{16}$/u;

export function socketFallbackDir(stateRoot: string): string {
  return join(SOCKET_FALLBACK_ROOT, `coral-${hashToken(stateRoot, SOCKET_FALLBACK_NAMESPACE_HASH_LENGTH)}`);
}

export function isRelocatedSocket(socketDirectory: string): boolean {
  const prefix = `${SOCKET_FALLBACK_ROOT}/`;
  return (
    socketDirectory.startsWith(prefix) &&
    !socketDirectory.slice(prefix.length).includes('/') &&
    SOCKET_FALLBACK_DIRECTORY_PATTERN.test(socketDirectory.slice(prefix.length))
  );
}
