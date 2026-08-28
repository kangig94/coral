import type { StoreResetSocketGuard, StoreResetTargetPaths } from '../store/operator-store-reset.js';
import type { Runtime } from '../runtime/ports.js';
import { acquireOperatorSocketGuard } from './operator-socket-guard.js';

export async function acquireStoreResetSocketGuard(
  paths: StoreResetTargetPaths,
  runtime: Runtime,
): Promise<StoreResetSocketGuard> {
  return acquireOperatorSocketGuard({
    runtime,
    operation: `${paths.target} store reset`,
    retryCommand: `coral-cli backend store-reset discard --target ${paths.target} --flavor ${runtime.flavor}`,
  });
}
