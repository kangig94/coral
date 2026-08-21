import { platform } from 'node:os';
import { join } from 'node:path';

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

/** 64 bits, because under one shared fallback root every overflowing state root on the host draws from a
 *  single namespace rather than from this installation's own. */
const FALLBACK_HASH_LENGTH = 16;

interface SocketPathEnvironment {
  readonly platform: string;
  readonly uid: number;
}

export function generationRunDir(flavor: BuildFlavor, opts?: CoordinatorPathOptions): string {
  return join(generationRoot(opts), flavor === 'dev' ? 'run-dev' : 'run');
}

export function socketPathForRunDir(runDir: string, flavor: BuildFlavor, env: SocketPathEnvironment): string {
  const candidateSocket = join(runDir, 'coordinator.sock');
  const limit = socketPathByteLimit(env.platform);
  if (Buffer.byteLength(candidateSocket, 'utf8') < limit) return candidateSocket;

  const hash = hashToken(candidateSocket, FALLBACK_HASH_LENGTH);
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
