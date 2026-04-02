export const CLAUDE_BROKER_BUSY_RPC_CODE = -32001;
export const CLAUDE_BROKER_BOOTSTRAP_MISMATCH_RPC_CODE = -32002;
export const CLAUDE_BROKER_STATE_RPC_CODE = -32003;
export const CLAUDE_BROKER_CHILD_EXIT_RPC_CODE = -32004;

export type JsonRpcId = number | string | null;

export interface JsonRpcRequest<TParams = Record<string, unknown>> {
  id: JsonRpcId;
  method: string;
  params?: TParams;
}

export interface JsonRpcNotification<TParams = Record<string, unknown>> {
  method: string;
  params?: TParams;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess<TResult = unknown> {
  id: JsonRpcId;
  result: TResult;
}

export interface JsonRpcFailure {
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<TResult = unknown> = JsonRpcSuccess<TResult> | JsonRpcFailure;

export interface ClaudeBootstrapSignature {
  cwd: string;
  systemPromptHash: string;
  permissionMode: string;
}

export interface SessionEnsureParams extends ClaudeBootstrapSignature {
  brokerSessionKey?: string;
  conversationRef?: string;
  controllerEnv?: Record<string, string>;
  systemPrompt?: string;
}

export interface SessionEnsureResult {
  brokerSessionKey: string;
  bootstrapSignature: ClaudeBootstrapSignature;
  sessionId: string | null;
  conversationRef: string | null;
  activeTurnId: string | null;
  initialized: boolean;
}

export interface SessionProbeParams {
  brokerSessionKey: string;
  conversationRef?: string;
}

export interface SessionProbeResult {
  brokerSessionKey: string;
  status: 'available' | 'missing' | 'unavailable';
  bootstrapSignature: ClaudeBootstrapSignature | null;
  sessionId: string | null;
  conversationRef: string | null;
  activeTurnId: string | null;
}

export interface TurnStartParams {
  brokerSessionKey: string;
  brokerTurnId: string;
  prompt: string;
  model?: string;
  maxThinkingTokens?: number | null;
}

export interface TurnStartResult {
  brokerSessionKey: string;
  brokerTurnId: string;
  sessionId: string | null;
  conversationRef: string | null;
}

export interface TurnInterruptParams {
  brokerSessionKey: string;
  brokerTurnId?: string;
}

export interface TurnInterruptResult {
  brokerTurnId: string | null;
  interrupted: boolean;
}

export interface BrokerShutdownResult {
  ok: true;
}

export interface SessionUpdatedParams {
  brokerSessionKey: string;
  bootstrapSignature: ClaudeBootstrapSignature;
  sessionId: string;
  conversationRef: string;
}

export interface TurnProgressParams {
  brokerSessionKey: string;
  brokerTurnId: string;
  message: string;
  sessionId: string | null;
  conversationRef: string | null;
}

export interface TurnCompletedParams {
  brokerSessionKey: string;
  brokerTurnId: string;
  sessionId: string | null;
  conversationRef: string | null;
  result: string;
  model: string | null;
  durationMs: number | null;
  numTurns: number | null;
  costUsd: number | null;
  usage: unknown;
  isError: boolean;
  subtype: string | null;
  errors?: string[];
}

export interface TurnFailedParams {
  brokerSessionKey: string;
  brokerTurnId: string | null;
  message: string;
  sessionId: string | null;
  conversationRef: string | null;
  stderr?: string;
}

export interface HostStatsParams {
  liveControllers: number;
  activeTurns: number;
}

export interface ClaudeBrokerNotificationMap {
  'session/updated': SessionUpdatedParams;
  'turn/progress': TurnProgressParams;
  'turn/completed': TurnCompletedParams;
  'turn/failed': TurnFailedParams;
  'host/stats': HostStatsParams;
}

export type ClaudeBrokerNotification = {
  [TMethod in keyof ClaudeBrokerNotificationMap]: {
    method: TMethod;
    params: ClaudeBrokerNotificationMap[TMethod];
  };
}[keyof ClaudeBrokerNotificationMap];

export interface ClaudeBrokerMethodMap {
  'session/ensure': { params: SessionEnsureParams; result: SessionEnsureResult };
  'session/probe': { params: SessionProbeParams; result: SessionProbeResult };
  'turn/start': { params: TurnStartParams; result: TurnStartResult };
  'turn/interrupt': { params: TurnInterruptParams; result: TurnInterruptResult };
  'broker/shutdown': { params: Record<string, never>; result: BrokerShutdownResult };
}

export type ClaudeBrokerMethod = keyof ClaudeBrokerMethodMap;

export class ClaudeBrokerRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ClaudeBrokerRpcError';
    this.code = code;
    this.data = data;
  }
}
