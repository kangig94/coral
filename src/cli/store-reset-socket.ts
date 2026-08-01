import type { BuildFlavor } from '../infra/build-flavor.js';
import type { StoreResetSocketGuard, StoreResetTargetPaths } from '../store/operator-store-reset.js';
import { acquireOperatorSocketGuard } from './operator-socket-guard.js';

export async function acquireStoreResetSocketGuard(
  paths: StoreResetTargetPaths,
  flavor: BuildFlavor,
): Promise<StoreResetSocketGuard> {
  return acquireOperatorSocketGuard({
    socketPath: paths.socketPath,
    flavor,
    operation: `${paths.target} store reset`,
    retryCommand: `coral-cli backend store-reset discard --target ${paths.target} --flavor ${flavor}`,
  });
}
