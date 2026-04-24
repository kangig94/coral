import type { AbortReason, ProviderTransportClose } from '../protocol.js';
import type { ProviderTerminalEventBody } from '../contract.js';
export type {
  AbortReason,
  AppServerNotificationMessage,
  AppServerSubscriptionPhase,
  ProviderTransportClose,
} from '../protocol.js';

export type DriverStepOutcome = {
  terminal?: TurnOutcome;
};

export type TurnOutcome =
  | { kind: 'completed'; turn: unknown }
  | { kind: 'failed'; message: string }
  | { kind: 'aborted'; reason: AbortReason };

export type AppServerTransportClosed<TClosed = ProviderTransportClose, TUpdate = never> = {
  terminal: ProviderTerminalEventBody;
  closed: TClosed;
  checkpoint?: TUpdate;
};
