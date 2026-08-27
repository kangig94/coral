import { platform } from 'node:os';
import { dirname, join } from 'node:path';

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

interface SocketPathEnvironment {
  readonly platform: string;
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

export function v0109CoordinatorSocketGuardPathsForRunDir(
  runDir: string,
  flavor: BuildFlavor,
  env: SocketPathEnvironment & Readonly<{ tempDirectories: readonly string[] }>,
): readonly string[] {
  const candidateSocket = join(runDir, 'coordinator.sock');
  if (Buffer.byteLength(candidateSocket, 'utf8') < socketPathByteLimit(env.platform)) return [];
  const hash = hashToken(candidateSocket, V0109_FALLBACK_HASH_LENGTH);
  return [...new Set(env.tempDirectories.map((directory) => join(directory, `coral-${flavor}-${hash}.sock`)))];
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
