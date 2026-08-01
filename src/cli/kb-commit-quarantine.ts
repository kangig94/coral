import { createServer, type Server } from 'node:net';
import { join } from 'node:path';

import type { BuildFlavor } from '../infra/build-flavor.js';
import { acquireDirectoryLock } from '../infra/fs-lock.js';
import { quarantineKbCommitEvidence } from '../kb/commit-quarantine.js';
import { KB_RUNTIME_AUTHORITY } from '../runtime/kb-runtime-authority.js';
import type { Runtime } from '../runtime/ports.js';
import { createRealRuntime } from '../runtime/real.js';
import { bindSocket } from '../transport/ipc/server.js';

const MAINTENANCE_LOCK_TIMEOUT_MS = 5_000;
const MAINTENANCE_LOCK_STALE_MS = 10 * 60 * 1_000;

export type QuarantineKbCommitOptions = {
  readonly runtime: Runtime;
  readonly commitId: string;
  readonly maintenanceTimeoutMs?: number;
};

export function quarantineKbCommitLocal(flavor: BuildFlavor, commitId: string) {
  return quarantineKbCommit({ runtime: createRealRuntime(flavor), commitId });
}

export async function quarantineKbCommit({
  runtime,
  commitId,
  maintenanceTimeoutMs = MAINTENANCE_LOCK_TIMEOUT_MS,
}: QuarantineKbCommitOptions) {
  const socketGuard = createServer();
  const binding = await bindSocket(socketGuard, runtime.paths.coral.coordinator.socketPath);
  if (binding.kind === 'incumbent') {
    throw new Error('KB commit quarantine requires the coordinator socket to be unbound.');
  }

  try {
    const releaseMaintenance = await acquireDirectoryLock(
      join(runtime.paths.coral.kbRuntime.root, KB_RUNTIME_AUTHORITY.mutationLock),
      {
        storage: runtime.storage,
        time: {
          now: () => runtime.time.now(),
          sleep: (ms) => runtime.time.sleep(ms),
          setInterval: runtime.time.setInterval.bind(runtime.time),
          clearInterval: runtime.time.clearInterval.bind(runtime.time),
        },
        staleMs: MAINTENANCE_LOCK_STALE_MS,
      },
      maintenanceTimeoutMs,
    );
    try {
      return quarantineKbCommitEvidence({
        runtimeDir: runtime.paths.coral.kbRuntime.root,
        storage: runtime.storage,
        commitId,
        stagingId: runtime.ids.uuid(),
        quarantinedAt: new Date(runtime.time.now()).toISOString(),
      });
    } finally {
      releaseMaintenance();
    }
  } finally {
    await closeSocketGuard(socketGuard);
  }
}

async function closeSocketGuard(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
