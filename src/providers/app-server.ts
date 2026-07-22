import type { ProviderRuntime, ProviderServerLease } from './contract.js';
import type { AppServerNotificationMessage, AppServerSubscriptionPhase } from './protocol.js';
import type { ProviderExecutionPlan } from './execution-plan.js';

export interface AppServerContract<_Plan extends ProviderExecutionPlan> {
  readonly name: string;
  readonly subscriptionPhase: AppServerSubscriptionPhase;
  interrupt(lease: ProviderServerLease): Promise<void>;
  onNotification?(message: AppServerNotificationMessage): void;
}

const appServerLeaseBindings = new WeakMap<object, ProviderServerLease>();
const appServerNotificationBindings = new WeakMap<object, (message: AppServerNotificationMessage) => void>();

export function bindAppServerLease<Plan extends ProviderExecutionPlan>(
  runtime: ProviderRuntime<Plan>,
  lease: ProviderServerLease,
): () => void {
  appServerLeaseBindings.set(runtime, lease);
  return () => {
    if (appServerLeaseBindings.get(runtime) === lease) {
      appServerLeaseBindings.delete(runtime);
    }
  };
}

function getAppServerLease<Plan extends ProviderExecutionPlan>(
  runtime: ProviderRuntime<Plan>,
): ProviderServerLease | undefined {
  return appServerLeaseBindings.get(runtime);
}

export function bindAppServerNotificationHandler<Plan extends ProviderExecutionPlan>(
  runtime: ProviderRuntime<Plan>,
  handler: (message: AppServerNotificationMessage) => void,
): () => void {
  appServerNotificationBindings.set(runtime, handler);
  return () => {
    if (appServerNotificationBindings.get(runtime) === handler) {
      appServerNotificationBindings.delete(runtime);
    }
  };
}

export function getAppServerNotificationHandler<Plan extends ProviderExecutionPlan>(
  runtime: ProviderRuntime<Plan>,
): ((message: AppServerNotificationMessage) => void) | undefined {
  return appServerNotificationBindings.get(runtime);
}

export function requireAppServerLease<Plan extends ProviderExecutionPlan>(
  runtime: ProviderRuntime<Plan>,
  providerName: string,
): ProviderServerLease {
  const lease = getAppServerLease(runtime);
  if (!lease) {
    throw new Error(`${providerName} provider requires app-server session middleware to bind a ProviderServerLease.`);
  }
  return lease;
}

export function buildProviderFailureMessage(label: string, message?: string, status?: string): string {
  if (typeof message === 'string') {
    const trimmed = message.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  if (typeof status === 'string') {
    const trimmed = status.trim();
    if (trimmed.length > 0) {
      return `${label} turn failed with status ${trimmed}.`;
    }
  }
  return `${label} session driver reported a failed turn.`;
}
