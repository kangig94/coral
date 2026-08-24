import type { Runtime } from '../runtime/ports.js';
import {
  readHandoffRoutingStatus,
  type HandoffRoutingStatusReadResult,
} from '../coordinator/handoff-routing-status.js';
import { quarantineHandoffRoutingStoreArtifact } from '../store/handoff-routing-status-store.js';
import { acquireGenerationMaintenanceLease } from '../store/generation-mutation-coordination.js';
import { acquireOperatorSocketGuard } from './operator-socket-guard.js';

type DiscardableRoutingStatus = Extract<
  HandoffRoutingStatusReadResult,
  { readonly kind: 'unreadable' | 'unsupported-generation' }
>;

type RefusedRoutingStatus = Exclude<HandoffRoutingStatusReadResult, DiscardableRoutingStatus>;

export type HandoffRoutingStatusDiscardResult =
  | Readonly<{
      kind: 'discarded';
      artifactPath: string;
      quarantinePath: string;
      previousStatus: DiscardableRoutingStatus;
    }>
  | Readonly<{ kind: 'refused'; status: RefusedRoutingStatus }>;

export async function discardHandoffRoutingStatus(
  runtime: Runtime,
  path: string,
): Promise<HandoffRoutingStatusDiscardResult> {
  const observedStatus = readHandoffRoutingStatus(runtime, path);
  if (observedStatus.kind !== 'unreadable' && observedStatus.kind !== 'unsupported-generation') {
    return { kind: 'refused', status: observedStatus };
  }

  const socket = await acquireOperatorSocketGuard({
    socketPath: runtime.paths.coral.coordinator.socketPath,
    flavor: runtime.flavor,
    operation: 'routing-status discard',
    retryCommand: 'coral-cli backend routing-status discard',
  });
  try {
    const maintenance = await acquireGenerationMaintenanceLease(runtime);
    try {
      maintenance.assertOwned();
      const currentStatus = readHandoffRoutingStatus(runtime, path);
      if (currentStatus.kind !== 'unreadable' && currentStatus.kind !== 'unsupported-generation') {
        return { kind: 'refused', status: currentStatus };
      }
      return {
        kind: 'discarded',
        artifactPath: path,
        quarantinePath: quarantineHandoffRoutingStoreArtifact(runtime.storage, path, runtime.ids.uuid()),
        previousStatus: currentStatus,
      };
    } finally {
      maintenance.release();
    }
  } finally {
    await socket.release();
  }
}
