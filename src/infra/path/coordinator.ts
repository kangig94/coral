import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BuildFlavor } from '../build-flavor.js';
import { hashToken } from '../hash.js';
import { coralStateRoot } from './root.js';

export interface CoordinatorPaths {
  runDir: string;
  socketPath: string;
  infoFile: string;
  startupErrorFile: string;
  startupDiagnosticFile: string;
  /** Run-dir projection of agent-facing tools installed via /equip, read by the
   *  session-start hook to advertise them in the injected session context. */
  equippedToolsFile: string;
}

export interface CoordinatorPathOptions {
  readonly baseDir?: string;
  readonly configSlot?: string;
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
  const runDir = join(coralStateRoot(opts?.configSlot, opts?.baseDir), base);
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
    startupErrorFile: join(runDir, 'startup-error.json'),
    startupDiagnosticFile: join(runDir, 'startup-diagnostic.json'),
    equippedToolsFile: join(runDir, 'equipped-tools.json'),
  };
}
