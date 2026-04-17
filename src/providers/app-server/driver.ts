import type { ProviderContinuityBlob, ProviderRequest, ProviderResult } from '../../shared/types.js';
import type { AbortReason } from '../../shared/coral-fault.js';
import type { ProviderRuntime, ProviderServerLease, ProviderServerSpec } from '../types.js';

export interface AppServerSessionDriver<TState> {
  readonly name: string;
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
  finalize(state: TState, outcome: TurnOutcome): ProviderResult;
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
  | { kind: 'aborted'; reason: AbortReason }
  | { kind: 'nonResumable'; message: string };
