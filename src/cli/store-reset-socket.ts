import type {
  StoreResetSocketGuard,
  StoreResetSocketGuardOperation,
  StoreResetTargetPaths,
} from '../store/operator-store-reset.js';
import type { Runtime } from '../runtime/ports.js';
import { acquireOperatorSocketGuard } from './operator-socket-guard.js';

export async function acquireStoreResetSocketGuard(
  paths: StoreResetTargetPaths,
  runtime: Runtime,
  command: StoreResetSocketGuardOperation,
): Promise<StoreResetSocketGuard> {
  const retryCommand =
    command.kind === 'discard'
      ? `coral-cli backend store-reset discard --target ${command.target} --flavor ${runtime.flavor}`
      : `coral-cli backend store-reset release ${command.epoch} --target ${command.target} --flavor ${runtime.flavor}`;
  return acquireOperatorSocketGuard({
    runtime,
    operation: `${paths.target} store reset ${command.kind}`,
    retryCommand,
  });
}
