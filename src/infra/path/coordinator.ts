import { platform } from 'node:os';
import { join } from 'node:path';

import type { BuildFlavor } from '../build-flavor.js';
import { hashToken } from '../hash.js';
import { generationRoot } from './root.js';

export interface CoordinatorPaths {
  runDir: string;
  socketPath: string;
  infoFile: string;
  startupErrorFile: string;
  startupDiagnosticFile: string;
}

export interface CoordinatorPathOptions {
  readonly baseDir?: string;
}

/**
 * 64 bits. Under an ambient fallback root the namespace was incidentally partitioned per user and per
 * sandbox; under a fixed root every overflowing state root on the host draws from this one space, and a
 * collision is two installations computing one socket path — the same two-owners-one-address failure the
 * fixed root exists to prevent, reached from the other side.
 */
export const SOCKET_FALLBACK_HASH_LENGTH = 16;

const SOCKET_LIMIT_DARWIN = 104;
const SOCKET_LIMIT_LINUX = 108;

interface SocketPathEnvironment {
  readonly platform: string;
  readonly uid: number;
}

/**
 * Where an overflowing socket path relocates to. It is a literal and not `TMPDIR` or `os.tmpdir()`
 * because moving the socket moves ownership: two processes over one state root that disagree about the
 * path both find their own unbound, both bind, and `design-rationale.md` §8.2 — exactly one coordinator
 * per installation — is what every ownership, recovery and handoff guarantee is written on top of. POSIX
 * guarantees this directory exists; Coral does not support a platform where it does not.
 *
 * The per-uid subdirectory is not decoration. The root itself is world-writable, and this socket is the
 * singleton lock: a path another user can occupy is a coordinator that stands down against a stranger's
 * socket, and a dead file another user owns makes the unlink that clears it fail `EPERM` on the startup
 * path. `socketFallbackDir` is what both resolvers must use.
 */
export const SOCKET_FALLBACK_ROOT = '/tmp';

export function socketFallbackDir(uid: number): string {
  return join(SOCKET_FALLBACK_ROOT, `coral-${uid}`);
}

export function socketPathByteLimit(platformName: string): number {
  return platformName === 'darwin' ? SOCKET_LIMIT_DARWIN : SOCKET_LIMIT_LINUX;
}

export function generationRunDir(flavor: BuildFlavor, opts?: CoordinatorPathOptions): string {
  return join(generationRoot(opts), flavor === 'dev' ? 'run-dev' : 'run');
}

export function socketPathForRunDir(runDir: string, flavor: BuildFlavor, env: SocketPathEnvironment): string {
  const candidateSocket = join(runDir, 'coordinator.sock');
  const limit = socketPathByteLimit(env.platform);
  if (Buffer.byteLength(candidateSocket, 'utf8') < limit) return candidateSocket;

  const hash = hashToken(candidateSocket, SOCKET_FALLBACK_HASH_LENGTH);
  return join(socketFallbackDir(env.uid), `coral-${flavor}-${hash}.sock`);
}

export function coordinatorPaths(flavor: BuildFlavor, opts?: CoordinatorPathOptions): CoordinatorPaths {
  const runDir = generationRunDir(flavor, opts);
  const socketPath = socketPathForRunDir(runDir, flavor, { platform: platform(), uid: process.getuid?.() ?? 0 });

  return {
    runDir,
    socketPath,
    infoFile: join(runDir, 'coordinator.json'),
    startupErrorFile: join(runDir, 'startup-error.json'),
    startupDiagnosticFile: join(runDir, 'startup-diagnostic.json'),
  };
}
