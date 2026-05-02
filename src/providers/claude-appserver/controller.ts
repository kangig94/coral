import { raceTimeout } from '../../infra/async.js';
import {
  claudeControlRequestSubtypes,
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
import { extractClaudeProgressMessage, formatToolProgress } from '../claude/progress.js';
import { hashSortedEnv, sameBootstrapSignature } from '../claude/request-prep.js';
import { buildClaudeChildEnv } from './child-env.js';
import {
  CLAUDE_BROKER_BOOTSTRAP_MISMATCH_RPC_CODE,
  CLAUDE_BROKER_BUSY_RPC_CODE,
  CLAUDE_BROKER_CHILD_EXIT_RPC_CODE,
  CLAUDE_BROKER_STATE_RPC_CODE,
  ClaudeBrokerRpcError,
  isAutoAllowPermissionMode,
  readSessionId,
  systemProgressMessage,
  toBootstrapSignature,
  type ClaudeBootstrapSignature,
  type SessionEnsureParams,
  type SessionEnsureResult,
  type SessionProbeParams,
  type SessionProbeResult,
  type TurnInterruptParams,
  type TurnInterruptResult,
  type TurnStartParams,
  type TurnStartResult,
} from './protocol.js';
import type {
  ChildExit,
  ClaudeBrokerChild,
  ControllerNotification,
  ControllerNotificationMap,
  CreateBrokerSessionOptions,
  SingleSessionControllerOptions,
} from './session-contract.js';

const DEFAULT_STDERR_RING_LIMIT = 16_384;
const CHILD_SHUTDOWN_GRACE_MS = 1_000;
const CHILD_SHUTDOWN_TIMEOUT_MS = 2_500;

type ControlRequestPayload =
  | SDKControlInitializeRequest
  | SDKControlInterruptRequest
  | SDKControlSetModelRequest
  | SDKControlSetMaxThinkingTokensRequest;

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

type ControllerSessionEnsureResult = Omit<SessionEnsureResult, 'brokerSessionKey'>;
type ControllerSessionProbeResult = Omit<SessionProbeResult, 'brokerSessionKey'>;
type ControllerTurnStartResult = Omit<TurnStartResult, 'brokerSessionKey'>;
type ControllerSessionProbeParams = Omit<SessionProbeParams, 'brokerSessionKey'>;
type ControllerTurnStartParams = Omit<TurnStartParams, 'brokerSessionKey'>;
type ControllerTurnInterruptParams = Omit<TurnInterruptParams, 'brokerSessionKey'>;

type ChildBinding = {
  child: ClaudeBrokerChild;
  closed: Promise<ChildExit>;
  dispose: () => void;
};

export class SingleSessionController {
  private readonly spawnChild: CreateBrokerSessionOptions['spawnChild'];
  private readonly onTurnStarted: CreateBrokerSessionOptions['onTurnStarted'];
  private readonly stderrLimit: number;
  private readonly ids: CreateBrokerSessionOptions['ids'];
  private readonly onUnexpectedExit: (() => void) | undefined;
  private readonly notificationHandlers = new Set<(notification: ControllerNotification) => void>();
  private readonly pendingControlRequests = new Map<string, PendingControlRequest>();

  private childBinding: ChildBinding | null = null;
  private bootstrapSignature: ClaudeBootstrapSignature | null = null;
  private bootstrapConfig: Omit<SessionEnsureParams, 'brokerSessionKey'> | null = null;
  private controllerEnvHash: string | null = null;
  private ensurePromise: Promise<ControllerSessionEnsureResult> | null = null;
  private initialized = false;
  private bootstrapEstablished = false;
  private latestSessionId: string | null = null;
  private activeTurn: ActiveTurnState | null = null;
  private lastTerminalTurnId: string | null = null;
  private stderrRing = '';
  private shuttingDown = false;
  private defaultModel: string | null = null;

  constructor(options: SingleSessionControllerOptions) {
    this.spawnChild = options.spawnChild;
    this.onTurnStarted = options.onTurnStarted;
    this.stderrLimit = options.stderrLimit ?? DEFAULT_STDERR_RING_LIMIT;
    this.ids = options.ids;
    this.onUnexpectedExit = options.onUnexpectedExit;
  }

  subscribeNotifications(handler: (notification: ControllerNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  async sessionEnsure(params: Omit<SessionEnsureParams, 'brokerSessionKey'>): Promise<ControllerSessionEnsureResult> {
    const signature = toBootstrapSignature(params);
    const controllerEnvHash = hashSortedEnv(buildClaudeChildEnv(params.controllerEnv));
    this.assertCompatibility(signature, controllerEnvHash);

    if (this.ensurePromise) {
      return this.ensurePromise;
    }

    if (this.childBinding && this.initialized) {
      return this.snapshot();
    }

    const ensurePromise = this.ensureInitializedSession(params, signature, controllerEnvHash);
    this.ensurePromise = ensurePromise;

    try {
      return await ensurePromise;
    } finally {
      if (this.ensurePromise === ensurePromise) {
        this.ensurePromise = null;
      }
    }
  }

  async sessionProbe(params: ControllerSessionProbeParams = {}): Promise<ControllerSessionProbeResult> {
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

  async turnStart(params: ControllerTurnStartParams): Promise<ControllerTurnStartResult> {
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
      const preTurnRequests: ControlRequestPayload[] = [];
      if (params.model !== undefined) {
        preTurnRequests.push({ subtype: claudeControlRequestSubtypes.setModel, model: params.model });
      }
      if (params.maxThinkingTokens !== undefined) {
        preTurnRequests.push({
          subtype: claudeControlRequestSubtypes.setMaxThinkingTokens,
          max_thinking_tokens: params.maxThinkingTokens,
        });
      }
      if (preTurnRequests.length > 0) {
        await Promise.all(preTurnRequests.map((req) => this.sendControlRequest(req)));
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

  async turnInterrupt(params: ControllerTurnInterruptParams = {}): Promise<TurnInterruptResult> {
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

  hasActiveTurn(): boolean {
    return this.activeTurn !== null;
  }

  hasLiveController(): boolean {
    return this.childBinding !== null;
  }

  canEvictReachableIdleController(): boolean {
    return this.activeTurn === null && this.currentConversationRef() !== null;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    if (!this.childBinding) {
      return;
    }

    const childBinding = this.childBinding;
    this.initialized = false;
    this.rejectPendingControlRequests(
      new ClaudeBrokerRpcError(CLAUDE_BROKER_STATE_RPC_CODE, 'Claude broker is shutting down.', this.errorData()),
    );
    childBinding.child.kill('SIGTERM');
    if (await this.waitForChildExit(childBinding.closed, CHILD_SHUTDOWN_GRACE_MS)) {
      return;
    }

    childBinding.child.kill('SIGKILL');
    if (await this.waitForChildExit(childBinding.closed, CHILD_SHUTDOWN_TIMEOUT_MS - CHILD_SHUTDOWN_GRACE_MS)) {
      return;
    }

    childBinding.dispose();
    if (this.childBinding === childBinding) {
      this.childBinding = null;
    }
  }

  private async ensureInitializedSession(
    params: Omit<SessionEnsureParams, 'brokerSessionKey'>,
    signature: ClaudeBootstrapSignature,
    controllerEnvHash: string,
  ): Promise<ControllerSessionEnsureResult> {
    if (!this.childBinding) {
      const conversationRef = params.conversationRef ?? this.latestSessionId ?? undefined;
      this.bootstrapSignature = signature;
      this.controllerEnvHash = controllerEnvHash;
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
    params: Omit<SessionEnsureParams, 'brokerSessionKey'>,
    signature: ClaudeBootstrapSignature,
  ): Promise<void> {
    const conversationRef =
      this.bootstrapConfig?.conversationRef ?? params.conversationRef ?? this.latestSessionId ?? undefined;
    const child = await this.spawnChild({
      cwd: signature.cwd,
      conversationRef,
      systemPrompt: params.systemPrompt,
      permissionMode: params.permissionMode,
      env: buildClaudeChildEnv(this.bootstrapConfig?.controllerEnv ?? params.controllerEnv),
    });

    const offStdout = child.onStdoutLine((line) => {
      this.handleChildLine(line);
    });
    let resolveClosed!: (event: ChildExit) => void;
    const closed = new Promise<ChildExit>((resolve) => {
      resolveClosed = resolve;
    });
    const offExit = child.onExit((event) => {
      resolveClosed(event);
      this.handleChildExit(event);
    });
    const offStderr = child.onStderrChunk?.((chunk) => {
      this.captureStderr(chunk);
    });

    this.childBinding = {
      child,
      closed,
      dispose: () => {
        offStdout();
        offExit();
        offStderr?.();
      },
    };
    this.initialized = false;
  }

  private waitForChildExit(closed: Promise<ChildExit>, timeoutMs: number): Promise<boolean> {
    return raceTimeout(closed, timeoutMs);
  }

  private handleChildLine(line: string): void {
    const message = parseClaudeStdoutLine(line);
    if (message === null) {
      return;
    }

    this.maybeUpdateSessionId(readSessionId(message));

    switch (message.type) {
      case 'keep_alive':
        return;
      case 'control_response':
        this.handleControlResponse(message);
        return;
      case 'control_request':
        this.handlePermissionRequest(message);
        return;
      case 'assistant':
        this.handleAssistantMessage(message);
        return;
      case 'system':
        this.handleSystemMessage(message);
        return;
      case 'result':
        this.handleResultMessage(message);
        return;
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

    if (this.activeTurn) {
      this.emitTurnProgress(
        this.activeTurn.brokerTurnId,
        formatToolProgress(message.request.tool_name, message.request.input, this.bootstrapSignature.cwd),
      );
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
        this.emitTurnFailure(this.activeTurn.brokerTurnId, rpcError.message);
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

    if (this.activeTurn === null || !this.bootstrapSignature) {
      return;
    }

    const progressMessage = extractClaudeProgressMessage(message, this.bootstrapSignature.cwd);
    if (!progressMessage) {
      return;
    }

    this.emitTurnProgress(this.activeTurn.brokerTurnId, progressMessage);
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

    this.emitTurnProgress(this.activeTurn.brokerTurnId, progressMessage);
  }

  private handleResultMessage(message: SDKResultMessage): void {
    const turn = this.activeTurn;
    if (turn === null) {
      return;
    }

    const completed: ControllerNotificationMap['turn/completed'] = {
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

    if (this.shuttingDown) {
      this.clearPendingControlRequests();
      return;
    }

    const exitError = this.childExitError(event);
    this.rejectPendingControlRequests(exitError);

    const turn = this.activeTurn;
    if (turn) {
      this.activeTurn = null;
      this.lastTerminalTurnId = turn.brokerTurnId;
      this.emitTurnFailure(turn.brokerTurnId, exitError.message);
    }

    this.onUnexpectedExit?.();
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
      throw new ClaudeBrokerRpcError(CLAUDE_BROKER_STATE_RPC_CODE, 'Claude child is unavailable.', this.errorData());
    }

    const requestId = this.ids.uuid();
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
      throw new ClaudeBrokerRpcError(CLAUDE_BROKER_STATE_RPC_CODE, 'Claude child is unavailable.', this.errorData());
    }

    try {
      this.childBinding.child.writeLine(ndjsonSafeStringify(message));
    } catch (error) {
      throw this.asRpcError(error, 'Failed to write to Claude child.');
    }
  }

  private assertCompatibility(signature: ClaudeBootstrapSignature, controllerEnvHash: string): void {
    if (this.bootstrapSignature === null || this.controllerEnvHash === null) {
      return;
    }

    if (sameBootstrapSignature(this.bootstrapSignature, signature) && this.controllerEnvHash === controllerEnvHash) {
      return;
    }

    throw new ClaudeBrokerRpcError(
      CLAUDE_BROKER_BOOTSTRAP_MISMATCH_RPC_CODE,
      'Claude broker controller compatibility mismatch.',
      this.errorData({
        expected: {
          bootstrapSignature: this.bootstrapSignature,
          envHash: this.controllerEnvHash,
        },
        actual: {
          bootstrapSignature: signature,
          envHash: controllerEnvHash,
        },
      }),
    );
  }

  private snapshot(): ControllerSessionEnsureResult {
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

  private buildTurnProgress(brokerTurnId: string, message: string): ControllerNotificationMap['turn/progress'] {
    return {
      brokerTurnId,
      message,
      sessionId: this.latestSessionId,
      conversationRef: this.currentConversationRef(),
    };
  }

  private emitTurnProgress(brokerTurnId: string, message: string): void {
    this.emitNotification({
      method: 'turn/progress',
      params: this.buildTurnProgress(brokerTurnId, message),
    });
  }

  private emitTurnFailure(brokerTurnId: string, message: string): void {
    this.emitNotification({
      method: 'turn/failed',
      params: {
        brokerTurnId,
        message,
        sessionId: this.latestSessionId,
        conversationRef: this.currentConversationRef(),
        stderr: this.stderrRing || undefined,
      },
    });
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
      const childBinding = this.childBinding;
      childBinding.child.kill('SIGTERM');
      childBinding.dispose();
      if (this.childBinding === childBinding) {
        this.childBinding = null;
      }
    }
    this.initialized = false;
    this.bootstrapSignature = null;
    this.bootstrapConfig = null;
    this.controllerEnvHash = null;
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

  private emitNotification(notification: ControllerNotification): void {
    for (const handler of this.notificationHandlers) {
      handler(notification);
    }
  }
}

function appendRingBuffer(current: string, next: string, limit: number): string {
  const combined = `${current}${next}`;
  if (combined.length <= limit) {
    return combined;
  }
  return combined.slice(combined.length - limit);
}
