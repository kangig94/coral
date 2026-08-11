import { platform, tmpdir } from 'node:os';
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

const SOCKET_LIMIT_DARWIN = 104;
const SOCKET_LIMIT_LINUX = 108;

interface SocketPathEnvironment {
  readonly platform: string;
  readonly tempDirectory: string;
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

  const hash = hashToken(candidateSocket, 8);
  return join(env.tempDirectory, `coral-${flavor}-${hash}.sock`);
}

export function coordinatorPaths(
  flavor: BuildFlavor,
  env: NodeJS.ProcessEnv = process.env,
  opts?: CoordinatorPathOptions,
): CoordinatorPaths {
  const runDir = generationRunDir(flavor, opts);
  const socketPath = socketPathForRunDir(runDir, flavor, {
    platform: platform(),
    tempDirectory: env.TMPDIR ?? tmpdir(),
  });

  return {
    runDir,
    socketPath,
    infoFile: join(runDir, 'coordinator.json'),
    startupErrorFile: join(runDir, 'startup-error.json'),
    startupDiagnosticFile: join(runDir, 'startup-diagnostic.json'),
  };
}
