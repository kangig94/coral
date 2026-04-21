import type { ProviderRequest, ProviderTerminalEventBody } from '../protocol.js';
import type {
  ProviderRequest as ContractProviderRequest,
  ProviderRuntime as ContractProviderRuntime,
  ProviderServerLease as ContractProviderServerLease,
  ProviderServerSpec as ContractProviderServerSpec,
} from '../contract.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import type { LegacyProviderName } from '../../shared/legacy-terminal-outcome-compat.js';
import type { ProviderRuntime, ProviderServerLease, ProviderServerSpec } from '../provider-contracts.js';
import type {
  AppServerNotificationMessage,
  AppServerSubscriptionPhase,
  DriverStepOutcome,
  TurnOutcome,
} from './types.js';

export type {
  AppServerNotificationMessage,
  AppServerSubscriptionPhase,
  DriverStepOutcome,
  ProviderTransportClose,
  TurnOutcome,
} from './types.js';

export interface AppServerContract {
  readonly name: string;
  readonly subscriptionPhase: AppServerSubscriptionPhase;
  buildServerSpec(
    request: ContractProviderRequest,
    persistedContinuity: ProviderContinuityBlob | undefined,
  ): ContractProviderServerSpec;
  interrupt(lease: ContractProviderServerLease): Promise<void>;
  onNotification?(message: AppServerNotificationMessage): void;
}

const appServerLeaseBindings = new WeakMap<ContractProviderRuntime, ContractProviderServerLease>();
const appServerNotificationBindings = new WeakMap<
  ContractProviderRuntime,
  (message: AppServerNotificationMessage) => void
>();

export function bindAppServerLease(
  runtime: ContractProviderRuntime,
  lease: ContractProviderServerLease,
): () => void {
  appServerLeaseBindings.set(runtime, lease);
  return () => {
    if (appServerLeaseBindings.get(runtime) === lease) {
      appServerLeaseBindings.delete(runtime);
    }
  };
}

export function getAppServerLease(runtime: ContractProviderRuntime): ContractProviderServerLease | undefined {
  return appServerLeaseBindings.get(runtime);
}

export function bindAppServerNotificationHandler(
  runtime: ContractProviderRuntime,
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
  runtime: ContractProviderRuntime,
): ((message: AppServerNotificationMessage) => void) | undefined {
  return appServerNotificationBindings.get(runtime);
}

export function requireAppServerLease(
  runtime: ContractProviderRuntime,
  providerName: string,
): ContractProviderServerLease {
  const lease = getAppServerLease(runtime);
  if (!lease) {
    throw new Error(`${providerName} provider requires app-server session middleware to bind a ProviderServerLease.`);
  }
  return lease;
}

export interface AppServerSessionDriver<TState> {
  readonly name: string;
  readonly faultProviderName: LegacyProviderName;
  readonly subscriptionPhase: AppServerSubscriptionPhase;

  buildServerSpec(
    request: ProviderRequest,
    persistedContinuity: ProviderContinuityBlob | undefined,
  ): ProviderServerSpec;
  createInitialState(ctx: DriverContext, request: ProviderRequest): TState;
  initialize(ctx: DriverContext, state: TState, request: ProviderRequest): Promise<DriverStepOutcome>;
  startTurn(ctx: DriverContext, state: TState, request: ProviderRequest): Promise<DriverStepOutcome>;
  applyNotification(state: TState, message: AppServerNotificationMessage): void;
  awaitTurnOutcome(state: TState): Promise<TurnOutcome>;
  requestInterrupt(ctx: DriverContext, state: TState): Promise<void>;
  onTransportClosed(state: TState, outcome: Error | void): TurnOutcome;
  finalize(state: TState, outcome: TurnOutcome): ProviderTerminalEventBody;
}

export interface DriverContext {
  lease: ProviderServerLease;
  runtime: ProviderRuntime;
  emitProgress(message: string): void;
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
