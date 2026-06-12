import { truncate } from '../../../infra/text.js';
import { MAX_BUFFER } from '../../../infra/process-constants.js';
import {
  buildJsonRpcError,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcSuccess,
} from '../../../infra/json-rpc.js';
import { isRecord } from '../../../infra/json.js';
import type { EffortLevel } from '../../contract.js';
import { permissionModeSchema, type ClaudeBootstrapSignature } from '../request-prep.js';

export const AUTO_ALLOW_PERMISSION_MODES: ReadonlySet<string> = new Set(['bypassPermissions', 'dontAsk']);

export const CLAUDE_BROKER_BUSY_RPC_CODE = -32001;
export const CLAUDE_BROKER_BOOTSTRAP_MISMATCH_RPC_CODE = -32002;
export const CLAUDE_BROKER_STATE_RPC_CODE = -32003;
export const CLAUDE_BROKER_CHILD_EXIT_RPC_CODE = -32004;
export const CLAUDE_BROKER_MAX_JSONL_LINE_BYTES = MAX_BUFFER;

export type JsonRpcInboundMessage<TParams = Record<string, unknown>> =
  | JsonRpcRequest<TParams>
  | JsonRpcNotification<TParams>;

export interface SessionEnsureParams extends ClaudeBootstrapSignature {
  brokerSessionKey?: string;
  conversationRef?: string;
  controllerEnv?: Record<string, string>;
  systemPrompt?: string;
  model?: string;
  effort?: EffortLevel;
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

export interface SessionCloseParams {
  brokerSessionKey: string;
}

export interface SessionCloseResult {
  brokerSessionKey: string;
  closed: boolean;
}

/** @wire anthropic:claude — turn/start request body. */
export interface TurnStartParams {
  brokerSessionKey: string;
  brokerTurnId: string;
  prompt: string;
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

export class JsonRpcLineTooLargeError extends ClaudeBrokerRpcError {
  readonly maxLineBytes: number;
  readonly observedBytes: number;

  constructor(observedBytes: number, maxLineBytes = CLAUDE_BROKER_MAX_JSONL_LINE_BYTES) {
    super(-32700, `JSON-RPC line exceeded ${maxLineBytes} bytes (observed ${observedBytes}).`, {
      code: 'json_rpc_line_too_large',
      maxLineBytes,
      observedBytes,
    });
    this.name = 'JsonRpcLineTooLargeError';
    this.maxLineBytes = maxLineBytes;
    this.observedBytes = observedBytes;
    Object.setPrototypeOf(this, JsonRpcLineTooLargeError.prototype);
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
  const lineBytes = Buffer.byteLength(line, 'utf8');
  if (lineBytes > CLAUDE_BROKER_MAX_JSONL_LINE_BYTES) {
    throw new JsonRpcLineTooLargeError(lineBytes);
  }

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
  const permissionMode = isRecord(params) ? permissionModeSchema.safeParse(params.permissionMode) : null;
  if (
    !isRecord(params) ||
    !isNonEmptyString(params.cwd) ||
    !isNonEmptyString(params.systemPromptHash) ||
    !permissionMode?.success
  ) {
    throw new ClaudeBrokerRpcError(-32602, 'Invalid params for session/ensure.');
  }

  const brokerSessionKey = readOptionalNonEmptyString(params.brokerSessionKey);
  const conversationRef = readOptionalNonEmptyString(params.conversationRef);
  const systemPrompt = typeof params.systemPrompt === 'string' ? params.systemPrompt : undefined;
  const model = typeof params.model === 'string' ? params.model : undefined;
  const effort = readEffortLevel(params.effort);
  return {
    cwd: params.cwd,
    systemPromptHash: params.systemPromptHash,
    permissionMode: permissionMode.data,
    ...(brokerSessionKey !== undefined ? { brokerSessionKey } : {}),
    ...(conversationRef !== undefined ? { conversationRef } : {}),
    controllerEnv: readControllerEnv(params.controllerEnv),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}

export function requireSessionProbeParams(params: unknown): SessionProbeParams {
  if (!isRecord(params) || !isNonEmptyString(params.brokerSessionKey)) {
    throw new ClaudeBrokerRpcError(-32602, 'Invalid params for session/probe.');
  }

  const conversationRef = readOptionalNonEmptyString(params.conversationRef);
  return {
    brokerSessionKey: params.brokerSessionKey,
    ...(conversationRef !== undefined ? { conversationRef } : {}),
  };
}

export function requireSessionCloseParams(params: unknown): SessionCloseParams {
  if (!isRecord(params) || !isNonEmptyString(params.brokerSessionKey)) {
    throw new ClaudeBrokerRpcError(-32602, 'Invalid params for session/close.');
  }

  return {
    brokerSessionKey: params.brokerSessionKey,
  };
}

export function requireTurnStartParams(params: unknown): TurnStartParams {
  if (
    !isRecord(params) ||
    !isNonEmptyString(params.brokerSessionKey) ||
    !isNonEmptyString(params.brokerTurnId) ||
    typeof params.prompt !== 'string'
  ) {
    throw new ClaudeBrokerRpcError(-32602, 'Invalid params for turn/start.');
  }

  return {
    brokerSessionKey: params.brokerSessionKey,
    brokerTurnId: params.brokerTurnId,
    prompt: params.prompt,
  };
}

export function requireTurnInterruptParams(params: unknown): TurnInterruptParams {
  if (!isRecord(params) || !isNonEmptyString(params.brokerSessionKey)) {
    throw new ClaudeBrokerRpcError(-32602, 'Invalid params for turn/interrupt.');
  }

  const brokerTurnId = readOptionalNonEmptyString(params.brokerTurnId);
  return {
    brokerSessionKey: params.brokerSessionKey,
    ...(brokerTurnId !== undefined ? { brokerTurnId } : {}),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function readOptionalNonEmptyString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

function readEffortLevel(value: unknown): EffortLevel | undefined {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max'
    ? value
    : undefined;
}

export function readControllerEnv(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ClaudeBrokerRpcError(-32602, 'Invalid params for session/ensure.');
  }

  const result: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== 'string') {
      throw new ClaudeBrokerRpcError(-32602, 'Invalid params for session/ensure.');
    }
    Object.defineProperty(result, key, {
      value: entryValue,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return result;
}

export function toBootstrapSignature(params: Omit<SessionEnsureParams, 'brokerSessionKey'>): ClaudeBootstrapSignature {
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
  if (!isRecord(message)) {
    return null;
  }
  if (typeof message.session_id === 'string') {
    return message.session_id;
  }
  return typeof message.sessionId === 'string' ? message.sessionId : null;
}

export function systemProgressMessage(message: Record<string, unknown>): string | null {
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
    default:
      return null;
  }
}

function firstNonEmpty(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}
