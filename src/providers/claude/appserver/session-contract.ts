import type { IdPort } from '../../../runtime/ports.js';
import type { EffortLevel } from '../../contract.js';
import type { PermissionMode } from '../request-prep.js';
import type {
  ClaudeBrokerNotification,
  SessionCloseParams,
  SessionCloseResult,
  SessionEnsureParams,
  SessionEnsureResult,
  SessionProbeParams,
  SessionProbeResult,
  SessionUpdatedParams,
  TurnCompletedParams,
  TurnFailedParams,
  TurnInterruptParams,
  TurnInterruptResult,
  TurnProgressParams,
  TurnStartParams,
  TurnStartResult,
} from './protocol.js';

export type ChildExit = {
  code: number | null;
  signal: NodeJS.Signals | string | number | null;
  error?: Error;
};

export type ControllerNotificationMap = {
  'session/updated': Omit<SessionUpdatedParams, 'brokerSessionKey'>;
  'turn/progress': Omit<TurnProgressParams, 'brokerSessionKey'>;
  'turn/completed': Omit<TurnCompletedParams, 'brokerSessionKey'>;
  'turn/failed': Omit<TurnFailedParams, 'brokerSessionKey'>;
};

export type ControllerNotification = {
  [TMethod in keyof ControllerNotificationMap]: {
    method: TMethod;
    params: ControllerNotificationMap[TMethod];
  };
}[keyof ControllerNotificationMap];

export interface ClaudeBrokerChild {
  write(data: string): void;
  kill(signal?: NodeJS.Signals): void;
  onData(handler: (chunk: string) => void): () => void;
  onExit(handler: (event: ChildExit) => void): () => void;
}

export interface SpawnClaudeChildOptions {
  cwd: string;
  conversationRef: string;
  resume: boolean;
  systemPrompt?: string;
  permissionMode: PermissionMode;
  model?: string;
  effort?: EffortLevel;
  env?: Record<string, string>;
}

export interface CreateBrokerSessionOptions {
  spawnChild: (options: SpawnClaudeChildOptions) => Promise<ClaudeBrokerChild> | ClaudeBrokerChild;
  ids: Pick<IdPort, 'uuid'>;
  onTurnStarted?: (turn: { brokerTurnId: string }) => Promise<void> | void;
  stderrLimit?: number;
}

export interface ClaudeBrokerSession {
  readonly closed: Promise<Error | void>;
  sessionEnsure(params: SessionEnsureParams): Promise<SessionEnsureResult>;
  sessionProbe(params: SessionProbeParams): Promise<SessionProbeResult>;
  sessionClose(params: SessionCloseParams): Promise<SessionCloseResult>;
  turnStart(params: TurnStartParams): Promise<TurnStartResult>;
  turnInterrupt(params: TurnInterruptParams): Promise<TurnInterruptResult>;
  shutdown(): Promise<void>;
  subscribeNotifications(handler: (notification: ClaudeBrokerNotification) => void): () => void;
}

export type SingleSessionControllerOptions = CreateBrokerSessionOptions & {
  onUnexpectedExit?: () => void;
  /** Wait after the bracketed-paste-ready marker before the first prompt. Defaults to the production constant. */
  readySettleMs?: number;
  /** No-transcript-activity window before a prompt is re-sent. Defaults to the production constant. */
  promptAckTimeoutMs?: number;
};
