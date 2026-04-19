import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BuildFlavor } from '../runtime/flavor.js';
import { hashToken } from '../shared/hash.js';
import { coralRoot } from './paths.js';

export interface CoordinatorPaths {
  runDir: string;
  socketPath: string;
  infoFile: string;
  lockFile: string;
}

export interface CoordinatorPathOptions {
  readonly baseDir?: string;
}

const SOCKET_LIMIT_DARWIN = 104;
const SOCKET_LIMIT_LINUX = 108;

function socketPathLimit(): number {
  return platform() === 'darwin' ? SOCKET_LIMIT_DARWIN : SOCKET_LIMIT_LINUX;
}

export function coordinatorPaths(
  flavor: BuildFlavor,
  env: NodeJS.ProcessEnv = process.env,
  opts?: CoordinatorPathOptions,
): CoordinatorPaths {
  const base = flavor === 'dev' ? 'run-dev' : 'run';
  const runDir = join(coralRoot(opts?.baseDir), base);
  const candidateSocket = join(runDir, 'coordinator.sock');
  const limit = socketPathLimit();
  let socketPath = candidateSocket;

  if (Buffer.byteLength(candidateSocket, 'utf8') >= limit) {
    const tmp = env.TMPDIR ?? tmpdir();
    const hash = hashToken(candidateSocket, 8);
    socketPath = join(tmp, `coral-${flavor}-${hash}.sock`);
  }

  return {
    runDir,
    socketPath,
    infoFile: join(runDir, 'coordinator.json'),
    lockFile: join(runDir, 'coordinator.lock'),
  };
}
