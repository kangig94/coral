import type { BuildFlavor } from '../infra/build-flavor.js';
import { createRealRuntime } from '../runtime/real.js';
import {
  adoptLegacyStore,
  type AdoptionSocketGuard,
  type LegacyStoreAdoptionResult,
} from '../store/legacy-store-adoption.js';
import { currentCoralStoreFormat } from '../store-format.js';
import { acquireOperatorSocketGuard } from './operator-socket-guard.js';

export async function acquireStoreAdoptionSocketGuard(
  socketPath: string,
  flavor: BuildFlavor,
): Promise<AdoptionSocketGuard> {
  return acquireOperatorSocketGuard({
    socketPath,
    flavor,
    operation: 'legacy store adoption',
    retryCommand: `coral-cli backend store-adopt --flavor ${flavor}`,
  });
}

export function adoptLegacyStoreLocal(flavor: BuildFlavor): Promise<LegacyStoreAdoptionResult> {
  return adoptLegacyStore({
    runtime: createRealRuntime(flavor),
    storeFormat: currentCoralStoreFormat(),
    acquireSocketGuard: acquireStoreAdoptionSocketGuard,
  });
}
