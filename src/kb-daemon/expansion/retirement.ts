import { join } from 'node:path';

import { isDirectoryLockTimeoutError } from '../../infra/fs-lock.js';
import { acquirePackageOperationLock } from '../../expansion/package-lock.js';
import { assertExpansionPackageId } from '../../expansion/package-id.js';
import type { ExpansionManifestCatalog } from '../../expansion/manifest/catalog.js';
import type { ConsumerDriver } from '../../projection-consumers/index.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';
import type { Runtime } from '../../runtime/ports.js';

export type RetiredExpansionCleanupResult = 'current' | 'removed';

export interface RetiredExpansionCleanupOptions {
  readonly runtime: Runtime;
  readonly kbRuntimeDir: string;
  readonly manifestCatalog: Pick<ExpansionManifestCatalog, 'hasCurrentEntry'>;
  readonly consumerDriver: Pick<ConsumerDriver, 'beginRetiredExpansionCursorCleanup'>;
  readonly finalizeState: () => void;
}

/**
 * Operator-authorized uninstall for an id that has left every current catalog.
 * The external package lock stays outside `engine.dataDir(id)`, so deleting the
 * target cannot destroy the exclusion fence.
 */
export async function cleanupRetiredExpansion(
  rawId: string,
  options: RetiredExpansionCleanupOptions,
): Promise<RetiredExpansionCleanupResult> {
  const id = assertExpansionPackageId(rawId);
  let releasePackageLock: () => void;
  try {
    releasePackageLock = await acquirePackageOperationLock(options.runtime, id);
  } catch (error) {
    if (isDirectoryLockTimeoutError(error)) {
      throw documentedCoralSetupError('expansion_install_lock_contended', { name: id });
    }
    throw error;
  }

  try {
    if (options.manifestCatalog.hasCurrentEntry(id)) {
      return 'current';
    }

    const cursorLease = options.consumerDriver.beginRetiredExpansionCursorCleanup(id);
    try {
      options.runtime.storage.rmSync(options.runtime.paths.coral.engine.dataDir(id), {
        recursive: true,
        force: true,
      });
      options.runtime.storage.rmSync(join(options.kbRuntimeDir, id), { recursive: true, force: true });
      options.runtime.storage.rmSync(join(options.kbRuntimeDir, `${id}-staging`), {
        recursive: true,
        force: true,
      });
      cursorLease.deleteCursor();
      options.finalizeState();
      return 'removed';
    } finally {
      cursorLease.release();
    }
  } finally {
    releasePackageLock();
  }
}
