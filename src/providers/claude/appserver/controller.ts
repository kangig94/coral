import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';

import { raceTimeout } from '../../../infra/async.js';
import { isRecord, readString } from '../../../infra/json.js';
import { resolveClaudeConfigDir } from '../../../infra/path/index.js';
import { MAX_BUFFER } from '../../../infra/process-constants.js';
import { formatToolProgress } from '../progress.js';
import { hashSortedEnv, sameBootstrapSignature, type ClaudeBootstrapSignature } from '../request-prep.js';
import { buildClaudeChildEnv } from './child-env.js';
import {
  CLAUDE_BROKER_BOOTSTRAP_MISMATCH_RPC_CODE,
  CLAUDE_BROKER_BUSY_RPC_CODE,
  CLAUDE_BROKER_CHILD_EXIT_RPC_CODE,
  CLAUDE_BROKER_STATE_RPC_CODE,
  ClaudeBrokerRpcError,
  readSessionId,
  systemProgressMessage,
  toBootstrapSignature,
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

const DEFAULT_OUTPUT_RING_LIMIT = 16_384;
const CHILD_SHUTDOWN_GRACE_MS = 1_000;
const CHILD_SHUTDOWN_TIMEOUT_MS = 2_500;
// Ceiling on the readiness wait — used when the marker never arrives or the
// output never quiesces. Proceed optimistically after this; the resend net
// then recovers a prompt the child was not ready for.
const CHILD_READY_TIMEOUT_MS = 5_000;
// Adaptive readiness window: once Claude emits the bracketed-paste-enable
// marker, the child is ready when its output stays quiet this long (the TUI
// has finished mounting the input box). A prompt pasted too soon is silently
// dropped by Claude Code 2.1.x; quiescing avoids both a dropped prompt and a
// fixed worst-case wait, and the resend net recovers any too-early send.
const CHILD_READY_QUIET_MS = 400;
const BRACKETED_PASTE_ENABLED = '\x1b[?2004h';
const TRANSCRIPT_POLL_MS = 100;
const RESUME_TRANSCRIPT_WAIT_MS = 2_000;
const POST_END_TURN_GRACE_MS = 1_500;
const TURN_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_TRANSCRIPT_READ_BYTES = MAX_BUFFER;
const MAX_TRANSCRIPT_LINE_BYTES = MAX_BUFFER;
// Safety net for a dropped prompt: if the transcript shows no activity within
// this window after a send, re-send the prompt; after MAX_PROMPT_RESENDS with
// no acknowledgement, fail fast instead of blocking until TURN_TIMEOUT_MS.
const PROMPT_ACK_TIMEOUT_MS = 2_500;
const MAX_PROMPT_RESENDS = 3;

type ActiveTurnState = {
  brokerTurnId: string;
  startedAt: number;
  transcriptOffset: number;
  transcriptRemainder: string;
  transcriptRemainderBytes: number;
  transcriptDecoder: StringDecoder;
  interruptRequested: boolean;
  interruptSent: boolean;
  userMessageSent: boolean;
  sawEndTurnAt: number | null;
  lastAssistantText: string;
  model: string | null;
  durationMs: number | null;
  usage: unknown;
  costUsd: number | null;
  errors: string[];
  promptPayload: string;
  lastPromptSentAt: number;
  promptResends: number;
  promptAcknowledged: boolean;
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
  ready: Promise<void>;
  dispose: () => void;
};

export class SingleSessionController {
  private readonly spawnChild: CreateBrokerSessionOptions['spawnChild'];
  private readonly onTurnStarted: CreateBrokerSessionOptions['onTurnStarted'];
  private readonly outputLimit: number;
  private readonly ids: CreateBrokerSessionOptions['ids'];
  private readonly onUnexpectedExit: (() => void) | undefined;
  private readonly readySettleMs: number;
  private readonly promptAckTimeoutMs: number;
  private readonly notificationHandlers = new Set<(notification: ControllerNotification) => void>();

  private childBinding: ChildBinding | null = null;
  private bootstrapSignature: ClaudeBootstrapSignature | null = null;
  private bootstrapConfig: Omit<SessionEnsureParams, 'brokerSessionKey'> | null = null;
  private controllerEnvHash: string | null = null;
  private ensurePromise: Promise<ControllerSessionEnsureResult> | null = null;
  private initialized = false;
  private latestSessionId: string | null = null;
  private transcriptPath: string | null = null;
  private resumeExistingConversation = false;
  private activeTurn: ActiveTurnState | null = null;
  private lastTerminalTurnId: string | null = null;
  private outputRing = '';
  private shuttingDown = false;

  constructor(options: SingleSessionControllerOptions) {
    this.spawnChild = options.spawnChild;
    this.onTurnStarted = options.onTurnStarted;
    this.outputLimit = options.stderrLimit ?? DEFAULT_OUTPUT_RING_LIMIT;
    this.ids = options.ids;
    this.onUnexpectedExit = options.onUnexpectedExit;
    this.readySettleMs = options.readySettleMs ?? CHILD_READY_QUIET_MS;
    this.promptAckTimeoutMs = options.promptAckTimeoutMs ?? PROMPT_ACK_TIMEOUT_MS;
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

    if (params.conversationRef !== undefined && params.conversationRef !== conversationRef) {
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
      startedAt: Date.now(),
      transcriptOffset: await this.readTranscriptOffsetBeforeTurn(),
      transcriptRemainder: '',
      transcriptRemainderBytes: 0,
      transcriptDecoder: new StringDecoder('utf8'),
      interruptRequested: false,
      interruptSent: false,
      userMessageSent: false,
      sawEndTurnAt: null,
      lastAssistantText: '',
      model: this.bootstrapConfig?.model ?? null,
      durationMs: null,
      usage: undefined,
      costUsd: null,
      errors: [],
      promptPayload: bracketedPaste(params.prompt),
      lastPromptSentAt: 0,
      promptResends: 0,
      promptAcknowledged: false,
    };
    this.activeTurn = turn;

    try {
      this.writeToChild(turn.promptPayload);
      turn.userMessageSent = true;
      turn.lastPromptSentAt = Date.now();

      if (turn.interruptRequested) {
        this.issueInterrupt(turn);
        this.finishInterruptedTurn(turn);
      }

      if (this.activeTurn === turn) {
        await this.onTurnStarted?.({ brokerTurnId: turn.brokerTurnId });
        void this.monitorTranscript(turn).catch((error) => {
          if (this.activeTurn === turn) {
            this.activeTurn = null;
            this.lastTerminalTurnId = turn.brokerTurnId;
            this.emitTurnFailure(turn.brokerTurnId, this.errorMessage(error));
          }
        });
      }

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
    if (params.brokerTurnId !== undefined && params.brokerTurnId !== turn.brokerTurnId) {
      return {
        brokerTurnId: turn.brokerTurnId,
        interrupted: false,
      };
    }

    turn.interruptRequested = true;
    if (turn.userMessageSent) {
      this.issueInterrupt(turn);
      this.finishInterruptedTurn(turn);
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
    try {
      this.writeToChild('/exit\r');
    } catch {
      // The child may already be gone; shutdown still proceeds through signals.
    }
    if (await this.waitForChildExit(childBinding.closed, CHILD_SHUTDOWN_GRACE_MS)) {
      return;
    }

    childBinding.child.kill('SIGTERM');
    if (await this.waitForChildExit(childBinding.closed, CHILD_SHUTDOWN_TIMEOUT_MS - CHILD_SHUTDOWN_GRACE_MS)) {
      return;
    }

    childBinding.child.kill('SIGKILL');
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
      const conversationRef = params.conversationRef ?? this.latestSessionId ?? this.ids.uuid();
      this.latestSessionId = conversationRef;
      this.bootstrapSignature = signature;
      this.controllerEnvHash = controllerEnvHash;
      this.resumeExistingConversation = params.conversationRef !== undefined;
      this.bootstrapConfig = {
        ...params,
        conversationRef,
      };
      await this.attachNewChild(params, signature, conversationRef, this.resumeExistingConversation);
      await this.waitForChildReady();
      if (!this.childBinding) {
        throw new ClaudeBrokerRpcError(
          CLAUDE_BROKER_CHILD_EXIT_RPC_CODE,
          'Claude child exited before the interactive prompt was ready.',
          this.errorData(),
        );
      }
      this.initialized = true;
      this.emitSessionUpdated(conversationRef);
    }

    return this.snapshot();
  }

  private async attachNewChild(
    params: Omit<SessionEnsureParams, 'brokerSessionKey'>,
    signature: ClaudeBootstrapSignature,
    conversationRef: string,
    resume: boolean,
  ): Promise<void> {
    let resolveReady!: () => void;
    let readyResolved = false;
    let readyOutput = '';
    let markerSeen = false;
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const finishReady = (): void => {
      if (readyResolved) {
        return;
      }
      readyResolved = true;
      if (capTimer !== null) {
        clearTimeout(capTimer);
        capTimer = null;
      }
      if (quietTimer !== null) {
        clearTimeout(quietTimer);
        quietTimer = null;
      }
      resolveReady();
    };
    // After the marker, (re)arm a quiet timer on every chunk; readiness fires
    // once output has been idle for the quiet window — adaptive, so a fast or
    // warm child proceeds early instead of waiting a fixed worst case.
    const armQuietTimer = (): void => {
      if (readyResolved) {
        return;
      }
      if (quietTimer !== null) {
        clearTimeout(quietTimer);
      }
      quietTimer = setTimeout(finishReady, this.readySettleMs);
      quietTimer.unref?.();
    };
    capTimer = setTimeout(finishReady, CHILD_READY_TIMEOUT_MS);
    capTimer.unref?.();

    const child = await this.spawnChild({
      cwd: signature.cwd,
      conversationRef,
      resume,
      systemPrompt: params.systemPrompt,
      permissionMode: params.permissionMode,
      model: params.model,
      effort: params.effort,
      env: buildClaudeChildEnv(this.bootstrapConfig?.controllerEnv ?? params.controllerEnv),
    });

    const offData = child.onData((chunk) => {
      if (!readyResolved) {
        readyOutput = appendRingBuffer(readyOutput, chunk, 4_096);
        if (!markerSeen && readyOutput.includes(BRACKETED_PASTE_ENABLED)) {
          markerSeen = true;
        }
        if (markerSeen) {
          armQuietTimer();
        }
      }
      this.captureOutput(chunk);
    });
    let resolveClosed!: (event: ChildExit) => void;
    const closed = new Promise<ChildExit>((resolve) => {
      resolveClosed = resolve;
    });
    const offExit = child.onExit((event) => {
      finishReady();
      resolveClosed(event);
      this.handleChildExit(event);
    });

    this.childBinding = {
      child,
      closed,
      ready,
      dispose: () => {
        finishReady();
        offData();
        offExit();
      },
    };
  }

  private async waitForChildReady(): Promise<void> {
    await this.childBinding?.ready;
  }

  private waitForChildExit(closed: Promise<ChildExit>, timeoutMs: number): Promise<boolean> {
    return raceTimeout(closed, timeoutMs);
  }

  private async readTranscriptOffsetBeforeTurn(): Promise<number> {
    const startedAt = Date.now();
    const waitForExistingTranscript = this.resumeExistingConversation;
    while (true) {
      const path = this.resolveTranscriptPath();
      if (path !== null) {
        return safeFileSize(path);
      }
      if (!waitForExistingTranscript || Date.now() - startedAt >= RESUME_TRANSCRIPT_WAIT_MS) {
        return 0;
      }
      await delay(TRANSCRIPT_POLL_MS);
    }
  }

  private async monitorTranscript(turn: ActiveTurnState): Promise<void> {
    while (this.activeTurn === turn) {
      this.readTranscriptAppend(turn);
      if (this.activeTurn !== turn) {
        return;
      }
      const now = Date.now();
      if (!turn.promptAcknowledged && this.resendUnacknowledgedPrompt(turn, now)) {
        return;
      }
      if (
        turn.sawEndTurnAt !== null &&
        (turn.durationMs !== null || now - turn.sawEndTurnAt >= POST_END_TURN_GRACE_MS)
      ) {
        this.completeTurn(turn);
        return;
      }
      if (now - turn.startedAt > TURN_TIMEOUT_MS) {
        this.activeTurn = null;
        this.lastTerminalTurnId = turn.brokerTurnId;
        this.emitTurnFailure(turn.brokerTurnId, 'Claude turn timed out waiting for a JSONL completion record.');
        return;
      }
      await delay(TRANSCRIPT_POLL_MS);
    }
  }

  // Claude can silently drop the first bracketed-paste prompt when its TUI is
  // not yet ready for input. Until the transcript shows activity for this turn,
  // re-send the prompt on a fixed cadence; once attempts are exhausted, fail
  // fast rather than block until TURN_TIMEOUT_MS. Returns true when the turn was
  // terminated so the caller stops monitoring.
  private resendUnacknowledgedPrompt(turn: ActiveTurnState, now: number): boolean {
    if (now - turn.lastPromptSentAt < this.promptAckTimeoutMs) {
      return false;
    }
    if (turn.promptResends >= MAX_PROMPT_RESENDS) {
      this.activeTurn = null;
      this.lastTerminalTurnId = turn.brokerTurnId;
      this.emitTurnFailure(
        turn.brokerTurnId,
        `Claude did not register the prompt after ${MAX_PROMPT_RESENDS} resend attempts; the interactive turn never started.`,
      );
      return true;
    }
    this.writeToChild(turn.promptPayload);
    turn.promptResends += 1;
    turn.lastPromptSentAt = now;
    this.emitTurnProgress(
      turn.brokerTurnId,
      `Claude did not acknowledge the prompt; re-sending (attempt ${turn.promptResends + 1}).`,
    );
    return false;
  }

  private readTranscriptAppend(turn: ActiveTurnState): void {
    const path = this.resolveTranscriptPath();
    if (path === null) {
      return;
    }

    const read = readFileSlice(path, turn.transcriptOffset);
    if (read === null) {
      return;
    }
    turn.transcriptOffset = read.offset;
    if (read.bytes.length === 0) {
      return;
    }
    turn.promptAcknowledged = true;

    const text = turn.transcriptDecoder.write(read.bytes);
    if (text.length > 0) {
      this.consumeTranscriptText(turn, text);
    }
  }

  private consumeTranscriptText(turn: ActiveTurnState, text: string): void {
    let start = 0;
    while (start < text.length) {
      const newlineIndex = text.indexOf('\n', start);
      if (newlineIndex === -1) {
        this.appendTranscriptFragment(turn, text.slice(start));
        return;
      }

      const fragmentEnd =
        newlineIndex > start && text.charCodeAt(newlineIndex - 1) === 13 ? newlineIndex - 1 : newlineIndex;
      if (!this.appendTranscriptFragment(turn, text.slice(start, fragmentEnd))) {
        return;
      }

      const line = turn.transcriptRemainder;
      turn.transcriptRemainder = '';
      turn.transcriptRemainderBytes = 0;
      if (line.trim().length > 0) {
        this.processTranscriptLine(turn, line);
        if (this.activeTurn !== turn) {
          return;
        }
      }
      start = newlineIndex + 1;
    }
  }

  private appendTranscriptFragment(turn: ActiveTurnState, fragment: string): boolean {
    if (fragment.length === 0) {
      return true;
    }
    const fragmentBytes = Buffer.byteLength(fragment, 'utf8');
    const observedBytes = turn.transcriptRemainderBytes + fragmentBytes;
    if (observedBytes > MAX_TRANSCRIPT_LINE_BYTES) {
      this.failOversizedTranscriptLine(turn, observedBytes);
      return false;
    }
    turn.transcriptRemainder += fragment;
    turn.transcriptRemainderBytes = observedBytes;
    return true;
  }

  private failOversizedTranscriptLine(turn: ActiveTurnState, observedBytes: number): void {
    if (this.activeTurn !== turn) {
      return;
    }

    turn.transcriptRemainder = '';
    turn.transcriptRemainderBytes = 0;
    this.activeTurn = null;
    this.lastTerminalTurnId = turn.brokerTurnId;
    this.emitTurnFailure(
      turn.brokerTurnId,
      `Claude transcript JSONL line exceeded ${MAX_TRANSCRIPT_LINE_BYTES} bytes (observed ${observedBytes}).`,
    );
  }

  private processTranscriptLine(turn: ActiveTurnState, line: string): void {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(row)) {
      return;
    }

    this.maybeUpdateSessionId(readSessionId(row));
    if (row.type === 'assistant') {
      this.handleAssistantTranscriptRow(turn, row);
      return;
    }
    if (row.type === 'system') {
      this.handleSystemTranscriptRow(turn, row);
    }
  }

  private handleAssistantTranscriptRow(turn: ActiveTurnState, row: Record<string, unknown>): void {
    const message = isRecord(row.message) ? row.message : null;
    if (message === null) {
      return;
    }

    const model = readString(message.model);
    if (model !== undefined) {
      turn.model = model;
    }
    if (message.usage !== undefined) {
      turn.usage = message.usage;
      turn.costUsd = readCostUsd(message.usage);
    }
    const error = readString(row.error);
    if (error !== undefined) {
      turn.errors.push(error);
    }

    const textParts: string[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }
      if (block.type === 'tool_use' && typeof block.name === 'string' && isRecord(block.input)) {
        this.emitTurnProgress(turn.brokerTurnId, formatToolProgress(block.name, block.input, this.currentCwd()));
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      }
    }
    if (textParts.length > 0) {
      turn.lastAssistantText = textParts.join('');
    }

    if (readString(message.stop_reason) === 'end_turn') {
      turn.sawEndTurnAt = Date.now();
    }
  }

  private handleSystemTranscriptRow(turn: ActiveTurnState, row: Record<string, unknown>): void {
    const progressMessage = systemProgressMessage(row);
    if (progressMessage !== null) {
      this.emitTurnProgress(turn.brokerTurnId, progressMessage);
    }

    if (row.subtype === 'turn_duration') {
      const durationMs = readNumber(row.durationMs) ?? readNumber(row.duration_ms);
      if (durationMs !== undefined) {
        turn.durationMs = durationMs;
      }
    }
  }

  private completeTurn(turn: ActiveTurnState): void {
    if (this.activeTurn !== turn) {
      return;
    }

    const completed: ControllerNotificationMap['turn/completed'] = {
      brokerTurnId: turn.brokerTurnId,
      sessionId: this.latestSessionId,
      conversationRef: this.currentConversationRef(),
      result: turn.lastAssistantText,
      model: turn.model,
      durationMs: turn.durationMs ?? Date.now() - turn.startedAt,
      numTurns: null,
      costUsd: turn.costUsd,
      usage: turn.usage,
      isError: turn.errors.length > 0,
      subtype: turn.errors.length > 0 ? 'error' : 'success',
      ...(turn.errors.length > 0 ? { errors: turn.errors } : {}),
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
      return;
    }

    const turn = this.activeTurn;
    if (turn) {
      this.activeTurn = null;
      this.lastTerminalTurnId = turn.brokerTurnId;
      this.emitTurnFailure(turn.brokerTurnId, this.childExitError(event).message);
    }

    this.onUnexpectedExit?.();
  }

  private maybeUpdateSessionId(sessionId: string | null): void {
    if (sessionId === null || sessionId === this.latestSessionId) {
      return;
    }

    this.latestSessionId = sessionId;
    if (this.bootstrapConfig) {
      this.bootstrapConfig = {
        ...this.bootstrapConfig,
        conversationRef: sessionId,
      };
    }
    this.emitSessionUpdated(sessionId);
  }

  private emitSessionUpdated(sessionId: string): void {
    if (this.bootstrapSignature === null) {
      return;
    }
    this.emitNotification({
      method: 'session/updated',
      params: {
        bootstrapSignature: this.bootstrapSignature,
        sessionId,
        conversationRef: sessionId,
      },
    });
  }

  private issueInterrupt(turn: ActiveTurnState): void {
    if (turn.interruptSent || !turn.userMessageSent) {
      return;
    }
    turn.interruptSent = true;
    this.writeToChild('\x03');
  }

  private finishInterruptedTurn(turn: ActiveTurnState): void {
    if (this.activeTurn !== turn) {
      return;
    }

    this.activeTurn = null;
    this.lastTerminalTurnId = turn.brokerTurnId;
    this.emitTurnFailure(turn.brokerTurnId, 'Claude turn interrupted.');
  }

  private writeToChild(data: string): void {
    if (!this.childBinding) {
      throw new ClaudeBrokerRpcError(CLAUDE_BROKER_STATE_RPC_CODE, 'Claude child is unavailable.', this.errorData());
    }

    try {
      this.childBinding.child.write(data);
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

  private currentCwd(): string {
    return this.bootstrapSignature?.cwd ?? process.cwd();
  }

  private resolveTranscriptPath(): string | null {
    const conversationRef = this.currentConversationRef();
    if (conversationRef === null) {
      return null;
    }
    if (this.transcriptPath !== null && existsSync(this.transcriptPath)) {
      return this.transcriptPath;
    }

    // The daemon preserves CLAUDE_CONFIG_DIR and forwards it to spawned `claude`
    // children, so their session logs land under the same config dir we read here.
    const projectsRoot = join(resolveClaudeConfigDir(process.env.CLAUDE_CONFIG_DIR, homedir()), 'projects');
    try {
      const projectEntries = readdirSync(projectsRoot, { withFileTypes: true });
      for (const entry of projectEntries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const candidate = join(projectsRoot, entry.name, `${conversationRef}.jsonl`);
        if (existsSync(candidate)) {
          this.transcriptPath = candidate;
          return candidate;
        }
      }
    } catch {
      return null;
    }
    return null;
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
        stderr: this.outputRing || undefined,
      },
    });
  }

  private captureOutput(chunk: string): void {
    this.outputRing = appendRingBuffer(this.outputRing, chunk, this.outputLimit);
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

  private asRpcError(error: unknown, fallbackMessage: string): ClaudeBrokerRpcError {
    if (error instanceof ClaudeBrokerRpcError) {
      return error;
    }
    if (error instanceof Error) {
      return new ClaudeBrokerRpcError(CLAUDE_BROKER_STATE_RPC_CODE, error.message || fallbackMessage, this.errorData());
    }
    return new ClaudeBrokerRpcError(CLAUDE_BROKER_STATE_RPC_CODE, fallbackMessage, this.errorData());
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private errorData(extra?: Record<string, unknown>): Record<string, unknown> {
    return {
      sessionId: this.latestSessionId,
      conversationRef: this.currentConversationRef(),
      initialized: this.initialized,
      activeTurnId: this.activeTurn?.brokerTurnId ?? null,
      ...(extra ?? {}),
    };
  }

  private emitNotification(notification: ControllerNotification): void {
    for (const handler of this.notificationHandlers) {
      handler(notification);
    }
  }
}

function bracketedPaste(prompt: string): string {
  return `\x1b[200~${prompt}\x1b[201~\r`;
}

function readFileSlice(path: string, offset: number): { bytes: Buffer; offset: number } | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size <= offset) {
      return { bytes: Buffer.alloc(0), offset: size };
    }
    const length = Math.min(size - offset, MAX_TRANSCRIPT_READ_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    return {
      bytes: buffer.subarray(0, bytesRead),
      offset: offset + bytesRead,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

function safeFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readCostUsd(value: unknown): number | null {
  if (!isRecord(value)) {
    return null;
  }
  return readNumber(value.costUSD) ?? readNumber(value.costUsd) ?? null;
}

function appendRingBuffer(current: string, chunk: string, limit: number): string {
  if (chunk.length >= limit) {
    return chunk.slice(-limit);
  }
  const combined = current + chunk;
  return combined.length <= limit ? combined : combined.slice(-limit);
}
