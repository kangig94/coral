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

export type ClaudeChildShutdownSubject = Readonly<{
  kind: 'claude-child';
  controller: 'tui' | 'print';
  generation: number;
}>;

export type ControllerShutdownObservedAbsent = Readonly<{
  kind: 'observed-absent';
  observation: 'absent';
  subjects: readonly ClaudeChildShutdownSubject[];
}>;

export type ControllerShutdownSuccessorAcceptance = Readonly<{
  kind: 'accepted';
  owner: 'broker-session-pool';
}>;

export interface ControllerShutdownSuccessor {
  readonly owner: 'broker-session-pool';
  accept(hold: ControllerShutdownHold): ControllerShutdownSuccessorAcceptance;
}

type ControllerShutdownHoldContinuation = Readonly<{
  subjects: readonly ClaudeChildShutdownSubject[];
  settled: Promise<ControllerShutdownObservedAbsent>;
  retry(): Promise<ControllerShutdownDisposition>;
  operatorExit: Readonly<{
    kind: 'transfer-to-broker-session-pool';
    transfer(successor: ControllerShutdownSuccessor): ControllerShutdownSuccessorAcceptance;
  }>;
}>;

export type ControllerShutdownHold = ControllerShutdownHoldContinuation &
  (
    | Readonly<{ kind: 'held-alive'; observation: 'alive' }>
    | Readonly<{ kind: 'held-unobservable'; observation: 'unobservable' }>
  );

export type ControllerShutdownDisposition = ControllerShutdownObservedAbsent | ControllerShutdownHold;

export type BrokerShutdownObservedAbsent = Readonly<{
  kind: 'observed-absent';
  observation: 'absent';
}>;

type BrokerShutdownHoldContinuation = Readonly<{
  subjects: readonly ClaudeChildShutdownSubject[];
  successor: ControllerShutdownSuccessorAcceptance;
  settled: Promise<BrokerShutdownObservedAbsent>;
  retry(): Promise<BrokerShutdownDisposition>;
  operatorExit: Readonly<{ kind: 'retry-broker-shutdown' }>;
}>;

export type BrokerShutdownHold = BrokerShutdownHoldContinuation &
  (
    | Readonly<{ kind: 'held-alive'; observation: 'alive' }>
    | Readonly<{ kind: 'held-unobservable'; observation: 'unobservable' }>
  );

export type BrokerShutdownDisposition = BrokerShutdownObservedAbsent | BrokerShutdownHold;

export interface BrokerSessionController {
  sessionEnsure(
    params: Omit<SessionEnsureParams, 'brokerSessionKey'>,
  ): Promise<Omit<SessionEnsureResult, 'brokerSessionKey'>>;
  sessionProbe(
    params: Omit<SessionProbeParams, 'brokerSessionKey'>,
  ): Promise<Omit<SessionProbeResult, 'brokerSessionKey'>>;
  turnStart(params: Omit<TurnStartParams, 'brokerSessionKey'>): Promise<Omit<TurnStartResult, 'brokerSessionKey'>>;
  turnInterrupt(params: Omit<TurnInterruptParams, 'brokerSessionKey'>): Promise<TurnInterruptResult>;
  shutdown(): Promise<ControllerShutdownDisposition>;
  subscribeNotifications(handler: (notification: ControllerNotification) => void): () => void;
  hasActiveTurn(): boolean;
  hasLiveController(): boolean;
  canEvictReachableIdleController(): boolean;
}

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

export interface ClaudePrintChild {
  writeLine(line: string): void;
  kill(signal?: NodeJS.Signals): void;
  onStdoutLine(handler: (line: string) => void): () => void;
  onExit(handler: (event: ChildExit) => void): () => void;
  onStderrChunk?(handler: (chunk: string) => void): () => void;
}

export interface SpawnClaudePrintChildOptions {
  cwd: string;
  conversationRef?: string;
  resume: boolean;
  systemPrompt?: string;
  permissionMode: PermissionMode;
  model?: string;
  effort?: EffortLevel;
  env?: Record<string, string>;
}

export interface BrokerSessionControllerOptions<TSpawnChild> {
  spawnChild: TSpawnChild;
  ids: Pick<IdPort, 'uuid'>;
  monotonicNow: () => bigint;
  onTurnStarted?: (turn: { brokerTurnId: string }) => Promise<void> | void;
  stderrLimit?: number;
}

export type TuiSpawnChild = (options: SpawnClaudeChildOptions) => Promise<ClaudeBrokerChild> | ClaudeBrokerChild;
export type PrintSpawnChild = (options: SpawnClaudePrintChildOptions) => Promise<ClaudePrintChild> | ClaudePrintChild;

export interface CreateBrokerSessionOptions<
  TSpawnChild = TuiSpawnChild,
> extends BrokerSessionControllerOptions<TSpawnChild> {
  createController?: (
    options: BrokerSessionControllerOptions<TSpawnChild> & { onUnexpectedExit?: () => void },
  ) => BrokerSessionController;
}

export interface ClaudeBrokerSession {
  readonly closed: Promise<Error | void>;
  sessionEnsure(params: SessionEnsureParams): Promise<SessionEnsureResult>;
  sessionProbe(params: SessionProbeParams): Promise<SessionProbeResult>;
  sessionClose(params: SessionCloseParams): Promise<SessionCloseResult>;
  turnStart(params: TurnStartParams): Promise<TurnStartResult>;
  turnInterrupt(params: TurnInterruptParams): Promise<TurnInterruptResult>;
  shutdown(): Promise<BrokerShutdownDisposition>;
  subscribeNotifications(handler: (notification: ClaudeBrokerNotification) => void): () => void;
}

export interface ControlRequestTimer {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export type SingleSessionControllerOptions = BrokerSessionControllerOptions<TuiSpawnChild> & {
  onUnexpectedExit?: () => void;
  /** Output-quiet window after the bracketed-paste marker that marks the child ready. Defaults to the production constant. */
  readySettleMs?: number;
  /** No-transcript-activity window before a prompt is re-sent. Defaults to the production constant. */
  promptAckTimeoutMs?: number;
};

export type PrintSessionControllerOptions = Omit<BrokerSessionControllerOptions<PrintSpawnChild>, 'monotonicNow'> & {
  onUnexpectedExit?: () => void;
  now: () => number;
  controlRequestTimer: ControlRequestTimer;
  controlRequestTimeoutMs?: number;
};
