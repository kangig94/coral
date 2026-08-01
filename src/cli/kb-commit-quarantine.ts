import type { BuildFlavor } from '../infra/build-flavor.js';
import { isDirectoryLockTimeoutError } from '../infra/fs-lock.js';
import { assertSafeCommitId, quarantineKbCommitEvidence } from '../kb/commit-quarantine.js';
import { CoralSetupError, documentedCoralSetupError } from '../runtime/errors.js';
import type { Runtime } from '../runtime/ports.js';
import { createRealRuntime } from '../runtime/real.js';
import {
  acquireGenerationAdoptionLease,
  acquireGenerationMaintenanceLease,
  type GenerationAdoptionLease,
  type GenerationMaintenanceLease,
} from '../store/generation-mutation-coordination.js';
import { currentCoralStoreFormat } from '../store-format.js';
import { acquireOperatorSocketGuard } from './operator-socket-guard.js';

const MAINTENANCE_LOCK_TIMEOUT_MS = 5_000;

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
  assertSafeCommitId(commitId);
  const retryCommand = `coral-cli backend kb-commit quarantine --flavor ${runtime.flavor} --commit ${commitId}`;
  const socketGuard = await acquireOperatorSocketGuard({
    socketPath: runtime.paths.coral.coordinator.socketPath,
    flavor: runtime.flavor,
    operation: 'KB commit quarantine',
    retryCommand,
  });

  try {
    const adoption = await acquireQuarantineAdoptionLease(runtime, maintenanceTimeoutMs, retryCommand);
    try {
      const maintenance = await acquireQuarantineMaintenanceLease(runtime, maintenanceTimeoutMs, retryCommand);
      try {
        adoption.assertOwned();
        maintenance.assertOwned();
        try {
          return quarantineKbCommitEvidence({
            runtimeDir: runtime.paths.coral.kbRuntime.root,
            storage: runtime.storage,
            commitId,
            stagingId: runtime.ids.uuid(),
            quarantinedAt: new Date(runtime.time.now()).toISOString(),
          });
        } catch (error: unknown) {
          if (error instanceof CoralSetupError) throw error;
          throw documentedCoralSetupError({
            code: 'kb_commit_quarantine_failed',
            commitId,
            reason: 'filesystem-operation-failed',
            cause: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        maintenance.release();
      }
    } finally {
      adoption.release();
    }
  } finally {
    await socketGuard.release();
  }
}

async function acquireQuarantineAdoptionLease(
  runtime: Runtime,
  timeoutMs: number,
  retryCommand: string,
): Promise<GenerationAdoptionLease> {
  try {
    return await acquireGenerationAdoptionLease(runtime, currentCoralStoreFormat(), timeoutMs);
  } catch (error: unknown) {
    throw boundQuarantineLeaseError(error, runtime, 'generation adoption lock', retryCommand);
  }
}

async function acquireQuarantineMaintenanceLease(
  runtime: Runtime,
  timeoutMs: number,
  retryCommand: string,
): Promise<GenerationMaintenanceLease> {
  try {
    return await acquireGenerationMaintenanceLease(runtime, timeoutMs);
  } catch (error: unknown) {
    throw boundQuarantineLeaseError(error, runtime, 'generation maintenance lock', retryCommand);
  }
}

function boundQuarantineLeaseError(
  error: unknown,
  runtime: Runtime,
  timeoutHolder: string,
  retryCommand: string,
): Error {
  if (isDirectoryLockTimeoutError(error)) {
    return documentedCoralSetupError({
      code: 'legacy_source_not_quiescent',
      operation: 'kb-commit',
      flavor: runtime.flavor,
      holder: timeoutHolder,
      retryCommand,
    });
  }
  if (error instanceof CoralSetupError && error.code === 'legacy_source_not_quiescent') {
    return documentedCoralSetupError({
      code: 'legacy_source_not_quiescent',
      operation: 'kb-commit',
      flavor: runtime.flavor,
      holder: error.context?.holder,
      retryCommand,
    });
  }
  return error instanceof Error
    ? error
    : documentedCoralSetupError({
        code: 'kb_commit_quarantine_failed',
        commitId: '<unknown>',
        reason: 'unknown-lease-failure',
      });
}
