import type { IdPort } from '../../runtime/ports.js';
import type { PermissionMode } from '../claude/control-protocol.js';
import type {
  ClaudeBrokerNotification,
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
  signal: NodeJS.Signals | null;
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
  writeLine(line: string): void;
  kill(signal?: NodeJS.Signals): void;
  onStdoutLine(handler: (line: string) => void): () => void;
  onExit(handler: (event: ChildExit) => void): () => void;
  onStderrChunk?(handler: (chunk: string) => void): () => void;
}

export interface SpawnClaudeChildOptions {
  cwd: string;
  conversationRef?: string;
  systemPrompt?: string;
  permissionMode: PermissionMode;
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
  turnStart(params: TurnStartParams): Promise<TurnStartResult>;
  turnInterrupt(params: TurnInterruptParams): Promise<TurnInterruptResult>;
  shutdown(): Promise<void>;
  subscribeNotifications(handler: (notification: ClaudeBrokerNotification) => void): () => void;
}

export type SingleSessionControllerOptions = CreateBrokerSessionOptions & {
  onUnexpectedExit?: () => void;
};
