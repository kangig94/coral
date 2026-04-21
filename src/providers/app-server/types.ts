import type { ProviderTerminalEventBody } from '../contract.js';

export type AppServerSubscriptionPhase = 'beforeInitialize' | 'afterInitialize';

export type AbortReason = 'signal_abort' | 'user_abort' | 'queue_shutdown';

export type AppServerNotificationMessage = {
  method: string;
  params?: Record<string, unknown>;
};

export type ProviderTransportClose =
  | {
      kind: 'transport_closed';
      error?: Error | null;
    };

export type DriverStepOutcome = {
  terminal?: TurnOutcome;
};

export type TurnOutcome =
  | { kind: 'completed'; turn: unknown }
  | { kind: 'failed'; message: string }
  | { kind: 'aborted'; reason: AbortReason }
  | { kind: 'nonResumable'; message: string };

export type AppServerTransportClosed<TClosed = ProviderTransportClose, TUpdate = never> = {
  terminal: ProviderTerminalEventBody;
  closed: TClosed;
  checkpoint?: TUpdate;
};
