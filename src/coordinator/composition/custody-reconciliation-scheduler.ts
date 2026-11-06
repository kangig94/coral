import { createBackgroundPhaseObserver } from '../../recovery/phase-observation.js';
import { observeDatabaseReads } from '../../recovery/read-observation.js';
import { join } from 'node:path';

import { formatError } from '../../infra/error-format.js';
import type { Runtime } from '../../runtime/ports.js';
import { resolveCurrentStoreEpoch } from '../../store/epoch/index.js';
import { reconcileStartupCustody } from '../services/recovery/custody-reconciliation.js';
import type { CoordinatorWorld } from './world.js';

export function createCustodyReconciliationScheduler(input: {
  runtime: Runtime;
  bootId: string;
  world: Pick<CoordinatorWorld, 'storeServicesRef' | 'log'>;
  selectedStoreEpochPath: () => string | null;
}): Readonly<{ arm: () => void }> {
  const { runtime, world } = input;
  let armed = false;
  const startPhase = createBackgroundPhaseObserver({
    time: runtime.time,
    log: world.log,
    bootId: input.bootId,
    phase: 'custody-reconciliation',
  });
  const reconcile = (): void => {
    const store = world.storeServicesRef.tryGet();
    if (store === null) {
      armed = false;
      return;
    }
    const observation = startPhase();
    let failed = false;
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
        observeDatabaseReads(store.progressStore.getDb(), observation, 'custody-operations'),
        selected ?? join(dbDir, `epoch-${epoch}`),
        {
          readProcessIncarnation: (pid) =>
            runtime.process.readProcessIncarnation(pid, runtime.env.platform() as NodeJS.Platform),
          capsuleExists: (path) => runtime.storage.existsSync(path),
        },
        observation,
        world.log,
      );
      if (!entries.some((entry) => entry.kind === 'holding' || entry.kind === 'unreadable')) {
        armed = false;
        return;
      }
    } catch (error: unknown) {
      failed = true;
      const reason = formatError(error);
      observation.reportState(JSON.stringify([{ identity: runtime.paths.coral.coordinator.runDir, reason }]));
    } finally {
      observation.finish(failed ? 'failed' : 'complete');
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
