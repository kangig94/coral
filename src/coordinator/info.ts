import { createHash } from 'node:crypto';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuildFlavor } from '../runtime/flavor.js';

export interface CoordinatorPaths {
  runDir: string;
  socketPath: string;
  infoFile: string;
  lockFile: string;
}

export interface CoordinatorPathOptions {
  readonly baseDir?: string;
}

// Platform limits for sockaddr_un.sun_path (per sys/un.h): Darwin=104, Linux=108.
// If the candidate path meets or exceeds the platform limit, fall back to $TMPDIR.
const SOCKET_LIMIT_DARWIN = 104;
const SOCKET_LIMIT_LINUX = 108;

function socketPathLimit(): number {
  return platform() === 'darwin' ? SOCKET_LIMIT_DARWIN : SOCKET_LIMIT_LINUX;
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

export function coordinatorPaths(
  flavor: BuildFlavor,
  env: NodeJS.ProcessEnv = process.env,
  opts?: CoordinatorPathOptions,
): CoordinatorPaths {
  const base = flavor === 'dev' ? 'run-dev' : 'run';
  const runDir = join(opts?.baseDir ?? join(homedir(), '.coral'), base);
  const candidateSocket = join(runDir, 'coordinator.sock');
  const limit = socketPathLimit();
  let socketPath = candidateSocket;
  if (Buffer.byteLength(candidateSocket, 'utf8') >= limit) {
    const tmp = env.TMPDIR ?? tmpdir();
    const hash = shortHash(candidateSocket);
    socketPath = join(tmp, `coral-${flavor}-${hash}.sock`);
  }
  return {
    runDir,
    socketPath,
    infoFile: join(runDir, 'coordinator.json'),
    lockFile: join(runDir, 'coordinator.lock'),
  };
}
