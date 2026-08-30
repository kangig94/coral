import type { Runtime } from '../runtime/ports.js';
import {
  clearHandoffRoutingStatusQuarantine as clearHandoffRoutingStatusQuarantineOwned,
  discardHandoffRoutingStatus as discardHandoffRoutingStatusOwned,
  type HandoffRoutingStatusDiscardResult,
  type HandoffRoutingStatusQuarantineClearResult,
} from '../coordinator/handoff-routing/status-operator.js';
import { acquireOperatorSocketGuard } from './operator-socket-guard.js';

export function discardHandoffRoutingStatus(
  runtime: Runtime,
  path: string,
): Promise<HandoffRoutingStatusDiscardResult> {
  return discardHandoffRoutingStatusOwned({ runtime, path, acquireSocketGuard: acquireOperatorSocketGuard });
}

export function clearHandoffRoutingStatusQuarantine(
  runtime: Runtime,
  path: string,
  quarantineId: string,
): Promise<HandoffRoutingStatusQuarantineClearResult> {
  return clearHandoffRoutingStatusQuarantineOwned(
    { runtime, path, acquireSocketGuard: acquireOperatorSocketGuard },
    quarantineId,
  );
}
