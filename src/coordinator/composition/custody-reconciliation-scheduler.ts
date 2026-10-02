import { join } from 'node:path';

import { formatError } from '../../infra/error-format.js';
import type { Runtime } from '../../runtime/ports.js';
import { resolveCurrentStoreEpoch } from '../../store/epoch/index.js';
import { reconcileStartupCustody } from '../services/recovery/custody-reconciliation.js';
import type { CoordinatorWorld } from './world.js';

export function createCustodyReconciliationScheduler(input: {
  runtime: Runtime;
  world: Pick<CoordinatorWorld, 'storeServicesRef' | 'log'>;
  selectedStoreEpochPath: () => string | null;
}): Readonly<{ arm: () => void }> {
  const { runtime, world } = input;
  let armed = false;
  let lastError: string | null = null;
  const reconcile = (): void => {
    const store = world.storeServicesRef.tryGet();
    if (store === null) {
      armed = false;
      return;
    }
    try {
      const dbDir = runtime.paths.coral.store.dbDir;
      const selected = input.selectedStoreEpochPath();
      const epoch = selected === null ? resolveCurrentStoreEpoch(runtime.storage, dbDir) : null;
      if (selected === null && epoch === null)
        throw new Error('Custody reconciliation requires a selected store epoch.');
      const entries = reconcileStartupCustody(
        runtime,
        runtime.paths.coral.coordinator.runDir,
        runtime.time.now(),
        store.progressStore.getDb(),
        selected ?? join(dbDir, `epoch-${epoch}`),
        {
          readProcessIncarnation: (pid) =>
            runtime.process.readProcessIncarnation(pid, runtime.env.platform() as NodeJS.Platform),
          capsuleExists: (path) => runtime.storage.existsSync(path),
        },
      );
      lastError = null;
      if (!entries.some((entry) => entry.kind === 'holding' || entry.kind === 'unreadable')) {
        armed = false;
        return;
      }
    } catch (error: unknown) {
      const reason = formatError(error);
      if (reason !== lastError) world.log(`Custody reconciliation remains undecidable: ${reason}\n`);
      lastError = reason;
    }
    const timer = runtime.time.setTimeout(reconcile, 1_000);
    timer.unref?.();
  };
  return {
    arm: () => {
      if (armed) return;
      armed = true;
      reconcile();
    },
  };
}
