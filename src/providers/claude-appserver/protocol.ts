import { truncate } from '../../infra/text.js';
import {
  buildJsonRpcError,
  type JsonRpcErrorObject,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcSuccess,
} from '../../infra/json-rpc.js';
import { isRecord } from '../../infra/json.js';
import type { PermissionMode, SDKSystemMessage } from '../claude/control-protocol.js';

export type {
  JsonRpcErrorObject,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccess,
};

export const AUTO_ALLOW_PERMISSION_MODES: ReadonlySet<string> = new Set(['bypassPermissions', 'dontAsk']);

export const CLAUDE_BROKER_BUSY_RPC_CODE = -32001;
export const CLAUDE_BROKER_BOOTSTRAP_MISMATCH_RPC_CODE = -32002;
export const CLAUDE_BROKER_STATE_RPC_CODE = -32003;
export const CLAUDE_BROKER_CHILD_EXIT_RPC_CODE = -32004;

export type JsonRpcInboundMessage<TParams = Record<string, unknown>> =
  | JsonRpcRequest<TParams>
  | JsonRpcNotification<TParams>;

export interface ClaudeBootstrapSignature {
  cwd: string;
  systemPromptHash: string;
  permissionMode: PermissionMode;
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

export type BrokerNotificationMethod = keyof ClaudeBrokerNotificationMap;

export const brokerNotificationMethods = {
  sessionUpdated: 'session/updated' as const satisfies BrokerNotificationMethod,
  turnProgress: 'turn/progress' as const satisfies BrokerNotificationMethod,
  turnCompleted: 'turn/completed' as const satisfies BrokerNotificationMethod,
  turnFailed: 'turn/failed' as const satisfies BrokerNotificationMethod,
  hostStats: 'host/stats' as const satisfies BrokerNotificationMethod,
};

export type ClaudeBrokerNotification = {
  [TMethod in keyof ClaudeBrokerNotificationMap]: {
    method: TMethod;
    params: ClaudeBrokerNotificationMap[TMethod];
  };
}[keyof ClaudeBrokerNotificationMap];

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

export function buildJsonRpcSuccess<TResult>(id: JsonRpcId, result: TResult): JsonRpcSuccess<TResult> {
  return { id, result };
}

export function buildJsonRpcFailure(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcFailure {
  return {
    id,
    error: buildJsonRpcError(code, message, data),
  };
}

export function buildJsonRpcFailureFromError(
  id: JsonRpcId,
  error: unknown,
  fallbackMessage = 'Claude broker request failed.',
): JsonRpcFailure {
  if (error instanceof ClaudeBrokerRpcError) {
    return buildJsonRpcFailure(id, error.code, error.message, error.data);
  }

  return buildJsonRpcFailure(id, -32000, error instanceof Error ? error.message : fallbackMessage);
}

export function parseJsonRpcInboundLine(line: string): JsonRpcInboundMessage<unknown> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch (error) {
    throw new ClaudeBrokerRpcError(-32700, `Invalid JSON: ${(error as Error).message}`);
  }

  if (!isRecord(message) || typeof message.method !== 'string') {
    throw new ClaudeBrokerRpcError(-32600, 'Invalid JSON-RPC request.');
  }

  return message as unknown as JsonRpcInboundMessage<unknown>;
}

export function requireSessionEnsureParams(params: unknown): SessionEnsureParams {
  if (
    !isRecord(params) ||
    typeof params.cwd !== 'string' ||
    typeof params.systemPromptHash !== 'string' ||
    typeof params.permissionMode !== 'string'
  ) {
    throw new ClaudeBrokerRpcError(-32602, 'Invalid params for session/ensure.');
  }

  return {
    cwd: params.cwd,
    systemPromptHash: params.systemPromptHash,
    permissionMode: params.permissionMode as PermissionMode,
    brokerSessionKey: typeof params.brokerSessionKey === 'string' ? params.brokerSessionKey : undefined,
    conversationRef: typeof params.conversationRef === 'string' ? params.conversationRef : undefined,
    controllerEnv: readControllerEnv(params.controllerEnv),
    systemPrompt: typeof params.systemPrompt === 'string' ? params.systemPrompt : undefined,
  };
}

export function requireSessionProbeParams(params: unknown): SessionProbeParams {
  if (!isRecord(params) || typeof params.brokerSessionKey !== 'string') {
    throw new ClaudeBrokerRpcError(-32602, 'Invalid params for session/probe.');
  }

  return {
    brokerSessionKey: params.brokerSessionKey,
    conversationRef: typeof params.conversationRef === 'string' ? params.conversationRef : undefined,
  };
}

export function requireTurnStartParams(params: unknown): TurnStartParams {
  if (
    !isRecord(params) ||
    typeof params.brokerSessionKey !== 'string' ||
    typeof params.brokerTurnId !== 'string' ||
    typeof params.prompt !== 'string'
  ) {
    throw new ClaudeBrokerRpcError(-32602, 'Invalid params for turn/start.');
  }

  return {
    brokerSessionKey: params.brokerSessionKey,
    brokerTurnId: params.brokerTurnId,
    prompt: params.prompt,
    model: typeof params.model === 'string' ? params.model : undefined,
    maxThinkingTokens:
      typeof params.maxThinkingTokens === 'number' || params.maxThinkingTokens === null
        ? params.maxThinkingTokens
        : undefined,
  };
}

export function requireTurnInterruptParams(params: unknown): TurnInterruptParams {
  if (!isRecord(params) || typeof params.brokerSessionKey !== 'string') {
    throw new ClaudeBrokerRpcError(-32602, 'Invalid params for turn/interrupt.');
  }

  return {
    brokerSessionKey: params.brokerSessionKey,
    brokerTurnId: typeof params.brokerTurnId === 'string' ? params.brokerTurnId : undefined,
  };
}

export function readControllerEnv(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ClaudeBrokerRpcError(-32602, 'Invalid params for session/ensure.');
  }

  const entries = Object.entries(value);
  if (entries.some(([, entryValue]) => typeof entryValue !== 'string')) {
    throw new ClaudeBrokerRpcError(-32602, 'Invalid params for session/ensure.');
  }

  return Object.fromEntries(entries) as Record<string, string>;
}

export function toBootstrapSignature(
  params: Omit<SessionEnsureParams, 'brokerSessionKey'>,
): ClaudeBootstrapSignature {
  return {
    cwd: params.cwd,
    systemPromptHash: params.systemPromptHash,
    permissionMode: params.permissionMode,
  };
}

export function stripBrokerSessionKey(params: SessionEnsureParams): Omit<SessionEnsureParams, 'brokerSessionKey'> {
  const { brokerSessionKey: _brokerSessionKey, ...rest } = params;
  return rest;
}

export function withBrokerSessionKey<TMethod extends Exclude<BrokerNotificationMethod, 'host/stats'>>(
  brokerSessionKey: string,
  notification: {
    method: TMethod;
    params: Omit<ClaudeBrokerNotificationMap[TMethod], 'brokerSessionKey'>;
  },
): Extract<ClaudeBrokerNotification, { method: TMethod }> {
  return {
    method: notification.method,
    params: {
      ...notification.params,
      brokerSessionKey,
    },
  } as Extract<ClaudeBrokerNotification, { method: TMethod }>;
}

export function isAutoAllowPermissionMode(permissionMode: string): boolean {
  return AUTO_ALLOW_PERMISSION_MODES.has(permissionMode);
}

export function readSessionId(message: unknown): string | null {
  return isRecord(message) && typeof message.session_id === 'string' ? message.session_id : null;
}

export function systemProgressMessage(message: SDKSystemMessage): string | null {
  switch (message.subtype) {
    case 'status':
      return typeof message.status === 'string' ? `Claude status: ${message.status}` : null;
    case 'api_retry':
      return `Claude API retry ${message.attempt}/${message.max_retries} after ${message.retry_delay_ms}ms`;
    case 'hook_started':
      return `Hook ${message.hook_name} started`;
    case 'hook_progress': {
      const output = firstNonEmpty(message.output, message.stdout, message.stderr);
      return output ? truncate(output, 120) : `Hook ${message.hook_name} running`;
    }
    case 'hook_response':
      return `Hook ${message.hook_name} ${message.outcome}`;
    case 'session_state_changed':
      return `Claude session ${message.state}`;
    case 'init':
      return null;
  }
}

function firstNonEmpty(...values: string[]): string | null {
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}
