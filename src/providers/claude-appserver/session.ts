import { randomUUID } from 'node:crypto';

import { formatToolProgress, truncate } from '../../shared/format-progress.js';
import { isRecord } from '../../shared/mcp-utils.js';
import {
  claudeControlRequestSubtypes,
  isAssistantMessage,
  isControlResponse,
  isKeepAliveMessage,
  isPermissionRequest,
  isResultMessage,
  isSystemMessage,
  ndjsonSafeStringify,
  parseClaudeStdoutLine,
  type SDKAssistantMessage,
  type SDKControlInitializeRequest,
  type SDKControlInterruptRequest,
  type SDKControlResponse,
  type SDKControlSetMaxThinkingTokensRequest,
  type SDKControlSetModelRequest,
  type SDKPermissionRequestMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
} from '../claude/control-protocol.js';
import { extractClaudeProgressMessage } from '../claude/progress.js';
import {
  CLAUDE_BROKER_BOOTSTRAP_MISMATCH_RPC_CODE,
  CLAUDE_BROKER_BUSY_RPC_CODE,
  CLAUDE_BROKER_CHILD_EXIT_RPC_CODE,
  CLAUDE_BROKER_STATE_RPC_CODE,
  ClaudeBrokerRpcError,
  type ClaudeBootstrapSignature,
  type ClaudeBrokerNotification,
  type SessionEnsureParams,
  type SessionEnsureResult,
  type SessionProbeParams,
  type SessionProbeResult,
  type TurnCompletedParams,
  type TurnFailedParams,
  type TurnInterruptParams,
  type TurnInterruptResult,
  type TurnProgressParams,
  type TurnStartParams,
  type TurnStartResult,
} from './protocol.js';

const DEFAULT_STDERR_RING_LIMIT = 16_384;
const AUTO_ALLOW_PERMISSION_MODES = new Set(['bypass', 'bypassPermissions', 'dontAsk']);

type ControlRequestPayload =
  | SDKControlInitializeRequest
  | SDKControlInterruptRequest
  | SDKControlSetModelRequest
  | SDKControlSetMaxThinkingTokensRequest;

type ChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

type PendingControlRequest = {
  subtype: ControlRequestPayload['subtype'];
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type ActiveTurnState = {
  brokerTurnId: string;
  prompt: string;
  userMessageSent: boolean;
  interruptRequested: boolean;
  interruptSent: boolean;
  model: string | null;
};

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
  permissionMode: string;
}

export interface CreateBrokerSessionOptions {
  spawnChild: (options: SpawnClaudeChildOptions) => Promise<ClaudeBrokerChild> | ClaudeBrokerChild;
  onTurnStarted?: (turn: { brokerTurnId: string }) => Promise<void> | void;
  stderrLimit?: number;
}

export interface ClaudeBrokerSession {
  readonly closed: Promise<Error | void>;
  sessionEnsure(params: SessionEnsureParams): Promise<SessionEnsureResult>;
  sessionProbe(params?: SessionProbeParams): Promise<SessionProbeResult>;
  turnStart(params: TurnStartParams): Promise<TurnStartResult>;
  turnInterrupt(params?: TurnInterruptParams): Promise<TurnInterruptResult>;
  shutdown(): Promise<void>;
  subscribeNotifications(handler: (notification: ClaudeBrokerNotification) => void): () => void;
}

type ChildBinding = {
  child: ClaudeBrokerChild;
  dispose: () => void;
};

class BrokerSessionController implements ClaudeBrokerSession {
  readonly closed: Promise<Error | void>;

  private readonly spawnChild: CreateBrokerSessionOptions['spawnChild'];
  private readonly onTurnStarted: CreateBrokerSessionOptions['onTurnStarted'];
  private readonly stderrLimit: number;
  private readonly notificationHandlers = new Set<(notification: ClaudeBrokerNotification) => void>();
  private readonly pendingControlRequests = new Map<string, PendingControlRequest>();

  private resolveClosed!: (value: Error | void) => void;
  private childBinding: ChildBinding | null = null;
  private bootstrapSignature: ClaudeBootstrapSignature | null = null;
  private bootstrapConfig: SessionEnsureParams | null = null;
  private ensurePromise: Promise<SessionEnsureResult> | null = null;
  private initialized = false;
  private bootstrapEstablished = false;
  private latestSessionId: string | null = null;
  private activeTurn: ActiveTurnState | null = null;
  private lastTerminalTurnId: string | null = null;
  private stderrRing = '';
  private shuttingDown = false;
  private defaultModel: string | null = null;

  constructor(options: CreateBrokerSessionOptions) {
    this.spawnChild = options.spawnChild;
    this.onTurnStarted = options.onTurnStarted;
    this.stderrLimit = options.stderrLimit ?? DEFAULT_STDERR_RING_LIMIT;
    this.closed = new Promise<Error | void>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  subscribeNotifications(handler: (notification: ClaudeBrokerNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  async sessionEnsure(params: SessionEnsureParams): Promise<SessionEnsureResult> {
    const signature = toBootstrapSignature(params);
    this.assertBootstrapCompatibility(signature);

    if (this.ensurePromise) {
      return this.ensurePromise;
    }

    if (this.childBinding && this.initialized) {
      return this.snapshot();
    }

    const ensurePromise = this.ensureInitializedSession(params, signature);
    this.ensurePromise = ensurePromise;

    try {
      return await ensurePromise;
    } finally {
      if (this.ensurePromise === ensurePromise) {
        this.ensurePromise = null;
      }
    }
  }

  async sessionProbe(params: SessionProbeParams = {}): Promise<SessionProbeResult> {
    const conversationRef = this.currentConversationRef();
    if (this.bootstrapSignature === null) {
      return {
        status: 'missing',
        bootstrapSignature: null,
        sessionId: null,
        conversationRef: null,
        activeTurnId: null,
      };
    }

    if (params.conversationRef && params.conversationRef !== conversationRef) {
      return {
        status: 'missing',
        bootstrapSignature: this.bootstrapSignature,
        sessionId: this.latestSessionId,
        conversationRef,
        activeTurnId: this.activeTurn?.brokerTurnId ?? null,
      };
    }

    return {
      status: this.childBinding ? 'available' : 'unavailable',
      bootstrapSignature: this.bootstrapSignature,
      sessionId: this.latestSessionId,
      conversationRef,
      activeTurnId: this.activeTurn?.brokerTurnId ?? null,
    };
  }

  async turnStart(params: TurnStartParams): Promise<TurnStartResult> {
    if (!this.childBinding || !this.initialized || this.bootstrapSignature === null) {
      throw new ClaudeBrokerRpcError(
        CLAUDE_BROKER_STATE_RPC_CODE,
        'Claude broker session is not initialized. Call session/ensure first.',
        this.errorData(),
      );
    }

    if (this.activeTurn !== null) {
      throw new ClaudeBrokerRpcError(CLAUDE_BROKER_BUSY_RPC_CODE, 'Claude broker is busy.', this.errorData());
    }

    const turn: ActiveTurnState = {
      brokerTurnId: params.brokerTurnId,
      prompt: params.prompt,
      userMessageSent: false,
      interruptRequested: false,
      interruptSent: false,
      model: params.model ?? this.defaultModel,
    };
    this.activeTurn = turn;

    try {
      if (params.model !== undefined) {
        await this.sendControlRequest({
          subtype: claudeControlRequestSubtypes.setModel,
          model: params.model,
        });
      }

      if (params.maxThinkingTokens !== undefined) {
        await this.sendControlRequest({
          subtype: claudeControlRequestSubtypes.setMaxThinkingTokens,
          max_thinking_tokens: params.maxThinkingTokens,
        });
      }

      this.writeChild({
        type: 'user',
        message: {
          role: 'user',
          content: params.prompt,
        },
        parent_tool_use_id: null,
        session_id: this.latestSessionId ?? undefined,
      });
      turn.userMessageSent = true;

      if (turn.interruptRequested) {
        await this.issueInterrupt(turn);
      }

      await this.onTurnStarted?.({ brokerTurnId: turn.brokerTurnId });

      return {
        brokerTurnId: params.brokerTurnId,
        sessionId: this.latestSessionId,
        conversationRef: this.currentConversationRef(),
      };
    } catch (error) {
      if (this.activeTurn === turn) {
        this.activeTurn = null;
      }
      this.lastTerminalTurnId = turn.brokerTurnId;
      throw this.asRpcError(error, 'Failed to start Claude turn.');
    }
  }

  async turnInterrupt(params: TurnInterruptParams = {}): Promise<TurnInterruptResult> {
    const turn = this.activeTurn;
    if (turn === null) {
      return {
        brokerTurnId: params.brokerTurnId ?? this.lastTerminalTurnId,
        interrupted: false,
      };
    }

    if (params.brokerTurnId && params.brokerTurnId !== turn.brokerTurnId) {
      return {
        brokerTurnId: turn.brokerTurnId,
        interrupted: false,
      };
    }

    turn.interruptRequested = true;
    if (turn.userMessageSent) {
      await this.issueInterrupt(turn);
    }

    return {
      brokerTurnId: turn.brokerTurnId,
      interrupted: true,
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    if (!this.childBinding) {
      this.resolveClosed();
      return;
    }

    const childBinding = this.childBinding;
    this.childBinding = null;
    this.initialized = false;
    this.rejectPendingControlRequests(
      new ClaudeBrokerRpcError(CLAUDE_BROKER_STATE_RPC_CODE, 'Claude broker is shutting down.', this.errorData()),
    );
    childBinding.child.kill('SIGTERM');
    childBinding.dispose();
    this.resolveClosed();
  }

  private async ensureInitializedSession(
    params: SessionEnsureParams,
    signature: ClaudeBootstrapSignature,
  ): Promise<SessionEnsureResult> {
    if (!this.childBinding) {
      const conversationRef = params.conversationRef ?? this.latestSessionId ?? undefined;
      this.bootstrapSignature = signature;
      this.bootstrapConfig = {
        ...params,
        conversationRef,
      };
      await this.attachNewChild(params, signature);
    }

    if (!this.initialized) {
      try {
        await this.sendControlRequest({
          subtype: claudeControlRequestSubtypes.initialize,
          systemPrompt: params.systemPrompt,
        });
        this.initialized = true;
        this.bootstrapEstablished = true;
      } catch (error) {
        this.resetFailedBootstrap();
        throw this.asRpcError(error, 'Claude session bootstrap failed.');
      }
    }

    return this.snapshot();
  }

  private async attachNewChild(
    params: SessionEnsureParams,
    signature: ClaudeBootstrapSignature,
  ): Promise<void> {
    const conversationRef = this.bootstrapConfig?.conversationRef ?? params.conversationRef ?? this.latestSessionId ?? undefined;
    const child = await this.spawnChild({
      cwd: signature.cwd,
      conversationRef,
      systemPrompt: params.systemPrompt,
      permissionMode: params.permissionMode,
    });

    const offStdout = child.onStdoutLine((line) => {
      this.handleChildLine(line);
    });
    const offExit = child.onExit((event) => {
      this.handleChildExit(event);
    });
    const offStderr = child.onStderrChunk?.((chunk) => {
      this.captureStderr(chunk);
    });

    this.childBinding = {
      child,
      dispose: () => {
        offStdout();
        offExit();
        offStderr?.();
      },
    };
    this.initialized = false;
  }

  private handleChildLine(line: string): void {
    const message = parseClaudeStdoutLine(line);
    if (message === null) {
      return;
    }

    this.maybeUpdateSessionId(readSessionId(message));

    if (isKeepAliveMessage(message)) {
      return;
    }

    if (isControlResponse(message)) {
      this.handleControlResponse(message);
      return;
    }

    if (isPermissionRequest(message)) {
      this.handlePermissionRequest(message);
      return;
    }

    if (isAssistantMessage(message)) {
      this.handleAssistantMessage(message);
      return;
    }

    if (isSystemMessage(message)) {
      this.handleSystemMessage(message);
      return;
    }

    if (isResultMessage(message)) {
      this.handleResultMessage(message);
    }
  }

  private handleControlResponse(message: SDKControlResponse): void {
    const pending = this.pendingControlRequests.get(message.response.request_id);
    if (!pending) {
      return;
    }

    this.pendingControlRequests.delete(message.response.request_id);
    if (message.response.subtype === 'error') {
      pending.reject(
        new ClaudeBrokerRpcError(
          CLAUDE_BROKER_STATE_RPC_CODE,
          message.response.error,
          this.errorData({
            pendingSubtype: pending.subtype,
          }),
        ),
      );
      return;
    }

    pending.resolve(message.response.response ?? {});
  }

  private handlePermissionRequest(message: SDKPermissionRequestMessage): void {
    if (!this.bootstrapSignature || !isAutoAllowPermissionMode(this.bootstrapSignature.permissionMode)) {
      return;
    }

    const progress = this.activeTurn
      ? this.buildTurnProgress(this.activeTurn.brokerTurnId, formatToolProgress(message.request.tool_name, message.request.input, this.bootstrapSignature.cwd))
      : null;
    if (progress) {
      this.emitNotification({
        method: 'turn/progress',
        params: progress,
      });
    }

    try {
      this.writeChild({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: message.request_id,
          response: {
            behavior: 'allow',
          },
        },
      });
    } catch (error) {
      const rpcError = this.asRpcError(error, 'Failed to auto-allow Claude tool request.');
      if (this.activeTurn) {
        this.emitNotification({
          method: 'turn/failed',
          params: {
            brokerTurnId: this.activeTurn.brokerTurnId,
            message: rpcError.message,
            sessionId: this.latestSessionId,
            conversationRef: this.currentConversationRef(),
            stderr: this.stderrRing || undefined,
          },
        });
      }
    }
  }

  private handleAssistantMessage(message: SDKAssistantMessage): void {
    if (message.message.model) {
      this.defaultModel = message.message.model;
      if (this.activeTurn) {
        this.activeTurn.model = message.message.model;
      }
    }

    if (this.activeTurn === null) {
      return;
    }

    const progressMessage = extractClaudeProgressMessage(message, this.bootstrapSignature?.cwd);
    if (!progressMessage) {
      return;
    }

    this.emitNotification({
      method: 'turn/progress',
      params: this.buildTurnProgress(this.activeTurn.brokerTurnId, progressMessage),
    });
  }

  private handleSystemMessage(message: SDKSystemMessage): void {
    if (message.subtype === 'init') {
      this.defaultModel = message.model;
    }

    if (this.activeTurn === null) {
      return;
    }

    const progressMessage = systemProgressMessage(message);
    if (!progressMessage) {
      return;
    }

    this.emitNotification({
      method: 'turn/progress',
      params: this.buildTurnProgress(this.activeTurn.brokerTurnId, progressMessage),
    });
  }

  private handleResultMessage(message: SDKResultMessage): void {
    const turn = this.activeTurn;
    if (turn === null) {
      return;
    }

    const completed: TurnCompletedParams = {
      brokerTurnId: turn.brokerTurnId,
      sessionId: this.latestSessionId,
      conversationRef: this.currentConversationRef(),
      result: 'result' in message && typeof message.result === 'string' ? message.result : '',
      model: turn.model,
      durationMs: message.duration_ms ?? null,
      numTurns: message.num_turns ?? null,
      costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : null,
      usage: message.usage,
      isError: message.is_error,
      subtype: message.subtype,
      errors:
        'errors' in message && Array.isArray(message.errors)
          ? message.errors.filter((value): value is string => typeof value === 'string')
          : undefined,
    };

    this.activeTurn = null;
    this.lastTerminalTurnId = turn.brokerTurnId;
    this.emitNotification({
      method: 'turn/completed',
      params: completed,
    });
  }

  private handleChildExit(event: ChildExit): void {
    const childBinding = this.childBinding;
    if (childBinding) {
      childBinding.dispose();
    }
    this.childBinding = null;
    this.initialized = false;

    const cleanExit = this.shuttingDown;
    if (cleanExit) {
      this.clearPendingControlRequests();
      this.resolveClosed();
      return;
    }

    const exitError = this.childExitError(event);
    this.rejectPendingControlRequests(exitError);

    const turn = this.activeTurn;
    if (turn) {
      const failed: TurnFailedParams = {
        brokerTurnId: turn.brokerTurnId,
        message: exitError.message,
        sessionId: this.latestSessionId,
        conversationRef: this.currentConversationRef(),
        stderr: this.stderrRing || undefined,
      };
      this.activeTurn = null;
      this.lastTerminalTurnId = turn.brokerTurnId;
      this.emitNotification({
        method: 'turn/failed',
        params: failed,
      });
    }

    this.resolveClosed(exitError);
  }

  private maybeUpdateSessionId(sessionId: string | null): void {
    if (!sessionId || sessionId === this.latestSessionId) {
      return;
    }

    this.latestSessionId = sessionId;
    if (this.bootstrapConfig) {
      this.bootstrapConfig = {
        ...this.bootstrapConfig,
        conversationRef: sessionId,
      };
    }
    if (this.bootstrapSignature) {
      this.emitNotification({
        method: 'session/updated',
        params: {
          bootstrapSignature: this.bootstrapSignature,
          sessionId,
          conversationRef: sessionId,
        },
      });
    }
  }

  private async sendControlRequest(request: ControlRequestPayload): Promise<unknown> {
    if (!this.childBinding) {
      throw new ClaudeBrokerRpcError(
        CLAUDE_BROKER_STATE_RPC_CODE,
        'Claude child is unavailable.',
        this.errorData(),
      );
    }

    const requestId = randomUUID();
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      this.pendingControlRequests.set(requestId, {
        subtype: request.subtype,
        resolve,
        reject,
      });
    });

    try {
      this.writeChild({
        type: 'control_request',
        request_id: requestId,
        request,
      });
    } catch (error) {
      this.pendingControlRequests.delete(requestId);
      throw error;
    }

    return responsePromise;
  }

  private async issueInterrupt(turn: ActiveTurnState): Promise<void> {
    if (turn.interruptSent || !turn.userMessageSent) {
      return;
    }

    turn.interruptSent = true;
    try {
      await this.sendControlRequest({
        subtype: claudeControlRequestSubtypes.interrupt,
      });
    } catch (error) {
      turn.interruptSent = false;
      throw error;
    }
  }

  private writeChild(message: unknown): void {
    if (!this.childBinding) {
      throw new ClaudeBrokerRpcError(
        CLAUDE_BROKER_STATE_RPC_CODE,
        'Claude child is unavailable.',
        this.errorData(),
      );
    }

    try {
      this.childBinding.child.writeLine(ndjsonSafeStringify(message));
    } catch (error) {
      throw this.asRpcError(error, 'Failed to write to Claude child.');
    }
  }

  private assertBootstrapCompatibility(signature: ClaudeBootstrapSignature): void {
    if (this.bootstrapSignature === null) {
      return;
    }

    if (sameBootstrapSignature(this.bootstrapSignature, signature)) {
      return;
    }

    throw new ClaudeBrokerRpcError(
      CLAUDE_BROKER_BOOTSTRAP_MISMATCH_RPC_CODE,
      'Claude broker bootstrap signature mismatch.',
      this.errorData({
        expected: this.bootstrapSignature,
        actual: signature,
      }),
    );
  }

  private snapshot(): SessionEnsureResult {
    if (this.bootstrapSignature === null) {
      throw new ClaudeBrokerRpcError(
        CLAUDE_BROKER_STATE_RPC_CODE,
        'Claude broker session has not been bootstrapped.',
        this.errorData(),
      );
    }

    return {
      bootstrapSignature: this.bootstrapSignature,
      sessionId: this.latestSessionId,
      conversationRef: this.currentConversationRef(),
      activeTurnId: this.activeTurn?.brokerTurnId ?? null,
      initialized: this.initialized,
    };
  }

  private currentConversationRef(): string | null {
    return this.latestSessionId ?? this.bootstrapConfig?.conversationRef ?? null;
  }

  private buildTurnProgress(brokerTurnId: string, message: string): TurnProgressParams {
    return {
      brokerTurnId,
      message,
      sessionId: this.latestSessionId,
      conversationRef: this.currentConversationRef(),
    };
  }

  private captureStderr(chunk: string): void {
    this.stderrRing = appendRingBuffer(this.stderrRing, chunk, this.stderrLimit);
  }

  private rejectPendingControlRequests(error: Error): void {
    for (const pending of this.pendingControlRequests.values()) {
      pending.reject(error);
    }
    this.pendingControlRequests.clear();
  }

  private clearPendingControlRequests(): void {
    this.pendingControlRequests.clear();
  }

  private childExitError(event: ChildExit): Error {
    if (event.error) {
      return this.asRpcError(event.error, `Claude child failed: ${event.error.message}`);
    }

    const detail =
      event.signal !== null
        ? `Claude child exited unexpectedly (signal ${event.signal}).`
        : `Claude child exited unexpectedly (exit ${event.code ?? 'unknown'}).`;
    return new ClaudeBrokerRpcError(CLAUDE_BROKER_CHILD_EXIT_RPC_CODE, detail, this.errorData());
  }

  private resetFailedBootstrap(): void {
    if (this.bootstrapEstablished) {
      return;
    }

    if (this.childBinding) {
      this.childBinding.dispose();
      this.childBinding = null;
    }
    this.initialized = false;
    this.bootstrapSignature = null;
    this.bootstrapConfig = null;
    this.latestSessionId = null;
    this.rejectPendingControlRequests(
      new ClaudeBrokerRpcError(CLAUDE_BROKER_STATE_RPC_CODE, 'Claude bootstrap failed.', this.errorData()),
    );
  }

  private asRpcError(error: unknown, fallbackMessage: string): ClaudeBrokerRpcError {
    if (error instanceof ClaudeBrokerRpcError) {
      return error;
    }

    return new ClaudeBrokerRpcError(
      CLAUDE_BROKER_STATE_RPC_CODE,
      error instanceof Error ? error.message : fallbackMessage,
      this.errorData(),
    );
  }

  private errorData(extra: Record<string, unknown> = {}): Record<string, unknown> | undefined {
    const data: Record<string, unknown> = { ...extra };
    if (this.stderrRing) {
      data.stderr = this.stderrRing;
    }
    return Object.keys(data).length > 0 ? data : undefined;
  }

  private emitNotification(notification: ClaudeBrokerNotification): void {
    for (const handler of this.notificationHandlers) {
      handler(notification);
    }
  }
}

export function createBrokerSession(options: CreateBrokerSessionOptions): ClaudeBrokerSession {
  return new BrokerSessionController(options);
}

function toBootstrapSignature(params: SessionEnsureParams): ClaudeBootstrapSignature {
  return {
    cwd: params.cwd,
    systemPromptHash: params.systemPromptHash,
    permissionMode: params.permissionMode,
  };
}

function sameBootstrapSignature(left: ClaudeBootstrapSignature, right: ClaudeBootstrapSignature): boolean {
  return (
    left.cwd === right.cwd &&
    left.systemPromptHash === right.systemPromptHash &&
    left.permissionMode === right.permissionMode
  );
}

function isAutoAllowPermissionMode(permissionMode: string): boolean {
  return AUTO_ALLOW_PERMISSION_MODES.has(permissionMode);
}

function appendRingBuffer(current: string, next: string, limit: number): string {
  const combined = `${current}${next}`;
  if (combined.length <= limit) {
    return combined;
  }
  return combined.slice(combined.length - limit);
}

function readSessionId(message: unknown): string | null {
  return isRecord(message) && typeof message.session_id === 'string' ? message.session_id : null;
}

function systemProgressMessage(message: SDKSystemMessage): string | null {
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
