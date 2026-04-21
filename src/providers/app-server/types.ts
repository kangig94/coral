import type { ProviderTerminalEventBody } from '../protocol.js';
import type { LegacyAbortReason } from '../../shared/legacy-terminal-outcome-compat.js';

export type AppServerSubscriptionPhase = 'beforeInitialize' | 'afterInitialize';

export type AppServerNotificationMessage = {
  method: string;
  params?: Record<string, unknown>;
};

export type ProviderTransportClose =
  | { kind: 'transport_closed' }
  | { kind: 'transport_error'; error: Error };

export type DriverStepOutcome = {
  terminal?: TurnOutcome;
};

export type TurnOutcome =
  | { kind: 'completed'; turn: unknown }
  | { kind: 'failed'; message: string }
  | { kind: 'aborted'; reason: LegacyAbortReason }
  | { kind: 'nonResumable'; message: string };

export type AppServerTransportClosed<TClosed = ProviderTransportClose, TUpdate = never> = {
  terminal: ProviderTerminalEventBody;
  closed: TClosed;
  checkpoint?: TUpdate;
};
