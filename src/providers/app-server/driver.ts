import type { ProviderRequest, ProviderTurnResult } from '../protocol.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import type { LegacyAbortReason, LegacyProviderName } from '../../shared/legacy-terminal-outcome-compat.js';
import type { ProviderRuntime, ProviderServerLease, ProviderServerSpec } from '../types.js';

export interface AppServerSessionDriver<TState> {
  readonly name: string;
  readonly faultProviderName: LegacyProviderName;
  readonly subscriptionPhase: 'beforeInitialize' | 'afterInitialize';

  buildServerSpec(
    request: ProviderRequest,
    persistedContinuity: ProviderContinuityBlob | undefined,
  ): ProviderServerSpec;
  createInitialState(ctx: DriverContext, request: ProviderRequest): TState;
  initialize(ctx: DriverContext, state: TState, request: ProviderRequest): Promise<DriverStepOutcome>;
  startTurn(ctx: DriverContext, state: TState, request: ProviderRequest): Promise<DriverStepOutcome>;
  applyNotification(state: TState, message: { method: string; params?: Record<string, unknown> }): void;
  awaitTurnOutcome(state: TState): Promise<TurnOutcome>;
  requestInterrupt(ctx: DriverContext, state: TState): Promise<void>;
  onTransportClosed(state: TState, outcome: Error | void): TurnOutcome;
  finalize(state: TState, outcome: TurnOutcome): ProviderTurnResult;
}

export interface DriverContext {
  lease: ProviderServerLease;
  runtime: ProviderRuntime;
  checkpointRecovery: NonNullable<ProviderRuntime['checkpointRecovery']>;
  emitProgress(message: string): void;
}

export type DriverStepOutcome = { terminal?: TurnOutcome };

export type TurnOutcome =
  | { kind: 'completed'; turn: unknown }
  | { kind: 'failed'; message: string }
  | { kind: 'aborted'; reason: LegacyAbortReason }
  | { kind: 'nonResumable'; message: string };

export function buildProviderFailureMessage(label: string, message?: string, status?: string): string {
  if (typeof message === 'string' && message.trim().length > 0) {
    return message.trim();
  }
  if (typeof status === 'string' && status.trim().length > 0) {
    return `${label} turn failed with status ${status.trim()}.`;
  }
  return `${label} session driver reported a failed turn.`;
}
