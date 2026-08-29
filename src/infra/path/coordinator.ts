import { platform } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';

import type { BuildFlavor } from '../build-flavor.js';
import { hashToken } from '../hash.js';
import { generationRoot } from './root.js';
import { socketFallbackDir, socketPathByteLimit } from './unix-socket.js';

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

const FALLBACK_HASH_LENGTH = 16;
const V0109_FALLBACK_HASH_LENGTH = 8;
const V0109_SOCKET_LIMIT_DARWIN = 104;
const V0109_SOCKET_LIMIT_OTHER = 108;

interface SocketPathEnvironment {
  readonly platform: string;
}

export type V0109CoordinatorSocketGuardSet =
  | Readonly<{ kind: 'primary-address'; paths: readonly [] }>
  | Readonly<{ kind: 'guarded-addresses'; paths: readonly string[] }>
  | Readonly<{
      kind: 'address-unenumerable';
      source: 'configured-temp-directory' | 'system-temp-directory';
      value: string;
    }>;

function v0109SocketPathByteLimit(platformName: string): number {
  return platformName === 'darwin' ? V0109_SOCKET_LIMIT_DARWIN : V0109_SOCKET_LIMIT_OTHER;
}

export function generationRunDir(flavor: BuildFlavor, opts?: CoordinatorPathOptions): string {
  return join(generationRoot(opts), flavor === 'dev' ? 'run-dev' : 'run');
}

export function handoffRoutingStatusPath(
  flavor: BuildFlavor,
  generation: number,
  opts?: CoordinatorPathOptions,
): string {
  return handoffRoutingStatusPathForRunDir(generationRunDir(flavor, opts), generation);
}

export function handoffRoutingStatusPathForRunDir(runDir: string, generation: number): string {
  return join(runDir, `handoff-routing.${generation}.db`);
}

export function socketPathForRunDir(runDir: string, flavor: BuildFlavor, env: SocketPathEnvironment): string {
  const candidateSocket = join(runDir, 'coordinator.sock');
  const limit = socketPathByteLimit(env.platform);
  if (Buffer.byteLength(candidateSocket, 'utf8') < limit) return candidateSocket;

  const hash = hashToken(candidateSocket, FALLBACK_HASH_LENGTH);
  return join(socketFallbackDir(dirname(runDir)), `coral-${flavor}-${hash}.sock`);
}

export function v0109CoordinatorSocketGuardSetForRunDir(
  runDir: string,
  flavor: BuildFlavor,
  env: SocketPathEnvironment &
    Readonly<{
      configuredTempDirectory: string | undefined;
      systemTempDirectory: string;
    }>,
): V0109CoordinatorSocketGuardSet {
  const path = env.platform === 'win32' ? win32 : posix;
  const candidateSocket = path.join(runDir, 'coordinator.sock');
  const candidateBytes = Buffer.byteLength(candidateSocket, 'utf8');
  if (candidateBytes < socketPathByteLimit(env.platform)) {
    return { kind: 'primary-address', paths: [] };
  }
  if (candidateBytes < v0109SocketPathByteLimit(env.platform)) {
    return { kind: 'guarded-addresses', paths: [candidateSocket] };
  }
  if (env.configuredTempDirectory !== undefined && !path.isAbsolute(env.configuredTempDirectory)) {
    return {
      kind: 'address-unenumerable',
      source: 'configured-temp-directory',
      value: env.configuredTempDirectory,
    };
  }
  if (!path.isAbsolute(env.systemTempDirectory)) {
    return {
      kind: 'address-unenumerable',
      source: 'system-temp-directory',
      value: env.systemTempDirectory,
    };
  }
  const hash = hashToken(candidateSocket, V0109_FALLBACK_HASH_LENGTH);
  const directories = [
    ...(env.configuredTempDirectory === undefined ? [] : [env.configuredTempDirectory]),
    env.systemTempDirectory,
  ];
  return {
    kind: 'guarded-addresses',
    paths: [...new Set(directories.map((directory) => path.join(directory, `coral-${flavor}-${hash}.sock`)))],
  };
}

export function coordinatorPaths(flavor: BuildFlavor, opts?: CoordinatorPathOptions): CoordinatorPaths {
  const runDir = generationRunDir(flavor, opts);
  const platformName = platform();
  const socketPath = socketPathForRunDir(runDir, flavor, { platform: platformName });

  return {
    runDir,
    socketPath,
    infoFile: join(runDir, 'coordinator.json'),
    startupErrorFile: join(runDir, 'startup-error.json'),
    startupDiagnosticFile: join(runDir, 'startup-diagnostic.json'),
  };
}
