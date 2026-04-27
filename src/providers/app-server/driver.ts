import type {
  ProviderRequest,
  ProviderRuntime,
  ProviderServerLease,
  ProviderServerSpec,
} from '../contract.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import type { AppServerNotificationMessage, AppServerSubscriptionPhase } from './driver-types.js';

export type {
  AppServerNotificationMessage,
  AppServerSubscriptionPhase,
} from './driver-types.js';

export interface AppServerContract {
  readonly name: string;
  readonly subscriptionPhase: AppServerSubscriptionPhase;
  buildServerSpec(
    request: ProviderRequest,
    persistedContinuity: ProviderContinuityBlob | undefined,
  ): ProviderServerSpec;
  interrupt(lease: ProviderServerLease): Promise<void>;
  onNotification?(message: AppServerNotificationMessage): void;
}

const appServerLeaseBindings = new WeakMap<ProviderRuntime, ProviderServerLease>();
const appServerNotificationBindings = new WeakMap<
  ProviderRuntime,
  (message: AppServerNotificationMessage) => void
>();

export function bindAppServerLease(
  runtime: ProviderRuntime,
  lease: ProviderServerLease,
): () => void {
  appServerLeaseBindings.set(runtime, lease);
  return () => {
    if (appServerLeaseBindings.get(runtime) === lease) {
      appServerLeaseBindings.delete(runtime);
    }
  };
}

export function getAppServerLease(runtime: ProviderRuntime): ProviderServerLease | undefined {
  return appServerLeaseBindings.get(runtime);
}

export function bindAppServerNotificationHandler(
  runtime: ProviderRuntime,
  handler: (message: AppServerNotificationMessage) => void,
): () => void {
  appServerNotificationBindings.set(runtime, handler);
  return () => {
    if (appServerNotificationBindings.get(runtime) === handler) {
      appServerNotificationBindings.delete(runtime);
    }
  };
}

export function getAppServerNotificationHandler(
  runtime: ProviderRuntime,
): ((message: AppServerNotificationMessage) => void) | undefined {
  return appServerNotificationBindings.get(runtime);
}

export function requireAppServerLease(
  runtime: ProviderRuntime,
  providerName: string,
): ProviderServerLease {
  const lease = getAppServerLease(runtime);
  if (!lease) {
    throw new Error(`${providerName} provider requires app-server session middleware to bind a ProviderServerLease.`);
  }
  return lease;
}

export function buildProviderFailureMessage(label: string, message?: string, status?: string): string {
  if (typeof message === 'string' && message.trim().length > 0) {
    return message.trim();
  }
  if (typeof status === 'string' && status.trim().length > 0) {
    return `${label} turn failed with status ${status.trim()}.`;
  }
  return `${label} session driver reported a failed turn.`;
}
