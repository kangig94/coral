import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';

import { raceTimeout } from '../../../infra/async.js';
import { sha256Hex } from '../../../infra/hash.js';
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
  TURN_FAILURE_DIAGNOSTIC_SCHEMA_VERSION,
  readSessionId,
  systemProgressMessage,
  toBootstrapSignature,
  type SessionEnsureParams,
  type SessionEnsureResult,
  type SessionProbeParams,
  type SessionProbeResult,
  type TurnFailureDiagnostic,
  type TurnFailureDiagnosticPhase,
  type TurnFailureDiagnosticReason,
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
import { DEFAULT_TURN_RECOVERY_BUDGET } from './turn-recovery-budget.js';

const DEFAULT_OUTPUT_RING_LIMIT = 16_384;
const CHILD_SHUTDOWN_GRACE_MS = 1_000;
const CHILD_SHUTDOWN_TIMEOUT_MS = 2_500;
// Adaptive readiness window: once Claude emits the bracketed-paste-enable
// marker, the child is ready when its output stays quiet this long (the TUI
// has finished mounting the input box). A prompt pasted too soon is silently
// dropped by Claude Code 2.1.x; quiescing avoids both a dropped prompt and a
// fixed worst-case wait, and the resend net recovers any too-early send.
const CHILD_READY_QUIET_MS = 400;
const BRACKETED_PASTE_ENABLED = '\x1b[?2004h';
const TRANSCRIPT_POLL_MS = 100;
const RESUME_TRANSCRIPT_WAIT_MS = 2_000;
const MAX_TRANSCRIPT_READ_BYTES = MAX_BUFFER;
const MAX_TRANSCRIPT_LINE_BYTES = MAX_BUFFER;

export type TurnPhase = TurnFailureDiagnosticPhase;
type ActiveTurnFailurePhase = Exclude<TurnFailureDiagnosticPhase, 'terminal'>;

const ALLOWED_TURN_PHASE_TRANSITIONS = {
  sent: new Set<TurnPhase>(['registered', 'responding', 'terminal']),
  registered: new Set<TurnPhase>(['responding', 'terminal']),
  responding: new Set<TurnPhase>(['ending', 'terminal']),
  ending: new Set<TurnPhase>(['terminal']),
  terminal: new Set<TurnPhase>(),
} as const satisfies Record<TurnPhase, ReadonlySet<TurnPhase>>;

export function advanceTurnPhase(current: TurnPhase, next: TurnPhase): TurnPhase {
  if (current === next) {
    return current;
  }
  if (!ALLOWED_TURN_PHASE_TRANSITIONS[current].has(next)) {
    throw new Error(`Illegal Claude turn phase transition: ${current} -> ${next}`);
  }
  return next;
}

type ActiveTurnState = {
  brokerTurnId: string;
  startedAt: number;
  phase: TurnPhase;
  phaseEnteredAt: number;
  lastSemanticProgressAt: number;
  promptTranscriptOffset: number;
  transcriptPath: string | null;
  transcriptOffset: number;
  transcriptLineStartOffset: number;
  transcriptRemainder: string;
  transcriptRemainderBytes: number;
  transcriptDecoder: StringDecoder;
  interruptRequested: boolean;
  interruptSent: boolean;
  userMessageSent: boolean;
  lastAssistantText: string;
  model: string | null;
  durationMs: number | null;
  usage: unknown;
  costUsd: number | null;
  errors: string[];
  promptText: string;
  promptTextHash: string;
  lastPromptSentAt: number;
  promptSendAttempts: number;
  replacementAttempts: number;
  continuationSentAt: number | null;
  continuationPhase: 'registered' | 'responding' | null;
};

type ControllerSessionEnsureResult = Omit<SessionEnsureResult, 'brokerSessionKey'>;
type ControllerSessionProbeResult = Omit<SessionProbeResult, 'brokerSessionKey'>;
type ControllerTurnStartResult = Omit<TurnStartResult, 'brokerSessionKey'>;
type ControllerSessionProbeParams = Omit<SessionProbeParams, 'brokerSessionKey'>;
type ControllerTurnStartParams = Omit<TurnStartParams, 'brokerSessionKey'>;
type ControllerTurnInterruptParams = Omit<TurnInterruptParams, 'brokerSessionKey'>;
type TranscriptCursor = {
  path: string | null;
  offset: number;
};

type ChildBinding = {
  generation: number;
  child: ClaudeBrokerChild;
  closed: Promise<ChildExit>;
  ready: Promise<void>;
  expectedExit: boolean;
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
  private childGeneration = 0;

  constructor(options: SingleSessionControllerOptions) {
    this.spawnChild = options.spawnChild;
    this.onTurnStarted = options.onTurnStarted;
    this.outputLimit = options.stderrLimit ?? DEFAULT_OUTPUT_RING_LIMIT;
    this.ids = options.ids;
    this.onUnexpectedExit = options.onUnexpectedExit;
    this.readySettleMs = options.readySettleMs ?? CHILD_READY_QUIET_MS;
    this.promptAckTimeoutMs = options.promptAckTimeoutMs ?? DEFAULT_TURN_RECOVERY_BUDGET.registration.promptAckMs;
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

    const now = Date.now();
    const transcriptCursor = await this.readTranscriptCursorBeforeTurn();
    const turn: ActiveTurnState = {
      brokerTurnId: params.brokerTurnId,
      startedAt: now,
      phase: 'sent',
      phaseEnteredAt: now,
      lastSemanticProgressAt: now,
      promptTranscriptOffset: transcriptCursor.offset,
      transcriptPath: transcriptCursor.path,
      transcriptOffset: transcriptCursor.offset,
      transcriptLineStartOffset: transcriptCursor.offset,
      transcriptRemainder: '',
      transcriptRemainderBytes: 0,
      transcriptDecoder: new StringDecoder('utf8'),
      interruptRequested: false,
      interruptSent: false,
      userMessageSent: false,
      lastAssistantText: '',
      model: this.bootstrapConfig?.model ?? null,
      durationMs: null,
      usage: undefined,
      costUsd: null,
      errors: [],
      promptText: params.prompt,
      promptTextHash: hashPromptText(params.prompt),
      lastPromptSentAt: 0,
      promptSendAttempts: 0,
      replacementAttempts: 0,
      continuationSentAt: null,
      continuationPhase: null,
    };
    this.activeTurn = turn;

    try {
      this.sendTuiPrompt(turn.promptText);
      turn.userMessageSent = true;
      turn.promptSendAttempts = 1;
      turn.lastPromptSentAt = Date.now();

      if (turn.interruptRequested) {
        this.issueInterrupt(turn);
        this.finishInterruptedTurn(turn);
      }

      if (this.activeTurn === turn) {
        await this.onTurnStarted?.({ brokerTurnId: turn.brokerTurnId });
        void this.monitorTranscript(turn).catch((error) => {
          if (this.activeTurn === turn) {
            this.failActiveTurn(turn, this.errorMessage(error));
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
        if (turn.userMessageSent) {
          try {
            this.issueInterrupt(turn);
          } catch {
            // The original turn/start failure remains the caller-visible error.
          }
        }
        this.transitionTurnPhase(turn, 'terminal');
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
    capTimer = setTimeout(finishReady, DEFAULT_TURN_RECOVERY_BUDGET.replacement.childReadyMs);
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
    const generation = ++this.childGeneration;
    // Forward reference: the onExit closure (created next) captures `binding`, and
    // `binding.dispose` references `offExit`, so the two form a cycle that cannot be
    // initialized in a single const declaration.
    // eslint-disable-next-line prefer-const
    let binding!: ChildBinding;
    const offExit = child.onExit((event) => {
      finishReady();
      resolveClosed(event);
      this.handleChildExit(binding, event);
    });

    binding = {
      generation,
      child,
      closed,
      ready,
      expectedExit: false,
      dispose: () => {
        finishReady();
        offData();
        offExit();
      },
    };
    this.childBinding = binding;
  }

  private async waitForChildReady(): Promise<void> {
    await this.childBinding?.ready;
  }

  private waitForChildExit(closed: Promise<ChildExit>, timeoutMs: number): Promise<boolean> {
    return raceTimeout(closed, timeoutMs);
  }

  private async readTranscriptCursorBeforeTurn(): Promise<TranscriptCursor> {
    const startedAt = Date.now();
    const waitForExistingTranscript = this.resumeExistingConversation;
    while (true) {
      const path = this.resolveTranscriptPath();
      if (path !== null) {
        return {
          path,
          offset: safeFileSize(path),
        };
      }
      if (!waitForExistingTranscript || Date.now() - startedAt >= RESUME_TRANSCRIPT_WAIT_MS) {
        return {
          path: null,
          offset: 0,
        };
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
      if (await this.recoverStalledTurn(turn, now)) {
        return;
      }
      await delay(TRANSCRIPT_POLL_MS);
    }
  }

  private async recoverStalledTurn(turn: ActiveTurnState, now: number): Promise<boolean> {
    if (this.activeTurn !== turn) {
      return true;
    }

    if (turn.phase === 'ending') {
      return this.recoverEndingTurn(turn, now);
    }

    if (now - turn.lastSemanticProgressAt >= DEFAULT_TURN_RECOVERY_BUDGET['hard-cap'].hardCapMs) {
      this.failActiveTurn(turn, 'Claude turn exceeded the no-semantic-progress recovery budget.');
      return true;
    }

    switch (turn.phase) {
      case 'sent':
        return this.recoverSentTurn(turn, now);
      case 'registered':
        if (!this.isContinuationBudgetBreached(turn, now, 'registered')) {
          return false;
        }
        return this.recoverByRespawningChild(turn, 'registered');
      case 'responding':
        if (!this.isContinuationBudgetBreached(turn, now, 'responding')) {
          return false;
        }
        return this.recoverByRespawningChild(turn, 'responding');
      case 'terminal':
        return true;
    }
  }

  private recoverSentTurn(turn: ActiveTurnState, now: number): boolean {
    if (now - turn.lastPromptSentAt < this.promptAckTimeoutMs) {
      return false;
    }
    if (turn.promptSendAttempts > DEFAULT_TURN_RECOVERY_BUDGET.registration.promptResends) {
      this.failActiveTurn(
        turn,
        `Claude did not register the prompt after ${DEFAULT_TURN_RECOVERY_BUDGET.registration.promptResends} resend attempts; the interactive turn never started.`,
      );
      return true;
    }
    this.sendTuiPrompt(turn.promptText);
    turn.promptSendAttempts += 1;
    turn.lastPromptSentAt = now;
    this.emitTurnProgress(
      turn.brokerTurnId,
      `Claude did not register the prompt; re-sending (attempt ${turn.promptSendAttempts}).`,
    );
    return false;
  }

  private recoverEndingTurn(turn: ActiveTurnState, now: number): boolean {
    if (
      turn.durationMs === null &&
      now - turn.phaseEnteredAt < DEFAULT_TURN_RECOVERY_BUDGET['finalization-grace'].finalizationGraceMs
    ) {
      return false;
    }
    this.completeTurn(turn);
    return true;
  }

  private isContinuationBudgetBreached(
    turn: ActiveTurnState,
    now: number,
    phase: 'registered' | 'responding',
  ): boolean {
    if (turn.continuationPhase === phase && turn.continuationSentAt !== null) {
      return now - turn.continuationSentAt >= DEFAULT_TURN_RECOVERY_BUDGET.replacement.continuationAckMs;
    }

    if (phase === 'registered') {
      return now - turn.phaseEnteredAt >= DEFAULT_TURN_RECOVERY_BUDGET['assistant-start'].assistantStartIdleMs;
    }
    return (
      now - turn.lastSemanticProgressAt >= DEFAULT_TURN_RECOVERY_BUDGET['assistant-progress'].assistantProgressIdleMs
    );
  }

  private async recoverByRespawningChild(turn: ActiveTurnState, phase: 'registered' | 'responding'): Promise<boolean> {
    if (turn.replacementAttempts >= DEFAULT_TURN_RECOVERY_BUDGET.replacement.respawnAttempts) {
      this.failActiveTurn(
        turn,
        phase === 'registered'
          ? 'Claude turn stalled after prompt registration and exhausted child respawn recovery.'
          : 'Claude turn stalled while responding and exhausted child respawn recovery.',
      );
      return true;
    }

    const conversationRef = this.currentConversationRef();
    if (conversationRef === null || this.bootstrapSignature === null || this.bootstrapConfig === null) {
      this.failActiveTurn(turn, 'Claude turn recovery could not resume because the session bootstrap is unavailable.');
      return true;
    }

    turn.replacementAttempts += 1;
    turn.continuationSentAt = null;
    turn.continuationPhase = null;
    const attempt = turn.replacementAttempts;
    const maxAttempts = DEFAULT_TURN_RECOVERY_BUDGET.replacement.respawnAttempts;
    this.emitTurnProgress(
      turn.brokerTurnId,
      `Claude turn stalled in ${phase}; respawning child for recovery (attempt ${attempt}/${maxAttempts}).`,
    );

    try {
      await this.replaceChildForRecovery(conversationRef);
      if (this.activeTurn !== turn) {
        return true;
      }
      this.sendTuiPrompt(this.continuationPromptForPhase(phase));
      turn.continuationSentAt = Date.now();
      turn.continuationPhase = phase;
      this.emitTurnProgress(
        turn.brokerTurnId,
        phase === 'registered'
          ? 'Claude child resumed; requested continuation for the unanswered user message.'
          : 'Claude child resumed; requested continuation of the partial assistant response.',
      );
      return false;
    } catch (error) {
      if (this.activeTurn !== turn) {
        return true;
      }
      const message = this.errorMessage(error);
      if (turn.replacementAttempts >= DEFAULT_TURN_RECOVERY_BUDGET.replacement.respawnAttempts) {
        this.failActiveTurn(
          turn,
          `Claude child respawn recovery failed after ${turn.replacementAttempts} attempts: ${message}`,
        );
        return true;
      }
      turn.continuationSentAt = Date.now();
      turn.continuationPhase = phase;
      this.emitTurnProgress(turn.brokerTurnId, `Claude child respawn recovery attempt ${attempt} failed: ${message}`);
      return false;
    }
  }

  private async replaceChildForRecovery(conversationRef: string): Promise<void> {
    if (this.bootstrapSignature === null || this.bootstrapConfig === null) {
      throw new ClaudeBrokerRpcError(
        CLAUDE_BROKER_STATE_RPC_CODE,
        'Claude broker session has no bootstrap configuration for recovery.',
        this.errorData(),
      );
    }

    const oldBinding = this.childBinding;
    if (oldBinding !== null) {
      this.beginExpectedChildShutdown(oldBinding);
    }
    this.initialized = false;
    this.resumeExistingConversation = true;
    this.latestSessionId = conversationRef;
    this.bootstrapConfig = {
      ...this.bootstrapConfig,
      conversationRef,
    };

    await this.attachNewChild(this.bootstrapConfig, this.bootstrapSignature, conversationRef, true);
    await this.waitForChildReady();
    if (!this.childBinding) {
      throw new ClaudeBrokerRpcError(
        CLAUDE_BROKER_CHILD_EXIT_RPC_CODE,
        'Claude child exited before the recovered interactive prompt was ready.',
        this.errorData(),
      );
    }
    this.initialized = true;
    this.emitSessionUpdated(conversationRef);
  }

  private beginExpectedChildShutdown(binding: ChildBinding): void {
    binding.expectedExit = true;
    try {
      binding.child.kill('SIGTERM');
    } catch {
      // The replacement path still proceeds; the background wait below will
      // detach this binding if the child never reports an exit.
    }
    void this.finishExpectedChildShutdown(binding).catch(() => {
      binding.dispose();
    });
  }

  private async finishExpectedChildShutdown(binding: ChildBinding): Promise<void> {
    if (await this.waitForChildExit(binding.closed, DEFAULT_TURN_RECOVERY_BUDGET.replacement.replacementShutdownMs)) {
      return;
    }

    try {
      binding.child.kill('SIGKILL');
    } catch {
      // The child is already considered replaced; disposal below removes our
      // stale listeners either way.
    }
    binding.dispose();
  }

  private continuationPromptForPhase(phase: 'registered' | 'responding'): string {
    if (phase === 'registered') {
      return 'Continue the unanswered user message from the resumed transcript. Do not restate or re-paste the original prompt; produce the assistant response now.';
    }
    return 'Continue the partial assistant response from the resumed transcript. Do not restart the answer, repeat prior assistant text, or re-paste the original prompt; continue from where the transcript stopped.';
  }

  private readTranscriptAppend(turn: ActiveTurnState): void {
    const path = this.resolveTranscriptPath();
    if (path === null) {
      return;
    }
    if (turn.transcriptPath !== path) {
      this.resetTurnTranscriptCursor(turn, path);
    }

    const read = readFileSlice(path, turn.transcriptOffset);
    if (read === null) {
      return;
    }
    turn.transcriptOffset = read.offset;
    if (read.bytes.length === 0) {
      return;
    }

    const text = turn.transcriptDecoder.write(read.bytes);
    if (text.length > 0) {
      this.consumeTranscriptText(turn, text);
    }
  }

  private resetTurnTranscriptCursor(turn: ActiveTurnState, path: string): void {
    turn.transcriptPath = path;
    turn.promptTranscriptOffset = 0;
    turn.transcriptOffset = 0;
    turn.transcriptLineStartOffset = 0;
    turn.transcriptRemainder = '';
    turn.transcriptRemainderBytes = 0;
    turn.transcriptDecoder = new StringDecoder('utf8');
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

      const lineStartOffset = turn.transcriptLineStartOffset;
      const lineEndOffset = lineStartOffset + turn.transcriptRemainderBytes;
      const lineBreakBytes = Buffer.byteLength(text.slice(fragmentEnd, newlineIndex + 1), 'utf8');
      const line = turn.transcriptRemainder;
      turn.transcriptRemainder = '';
      turn.transcriptRemainderBytes = 0;
      turn.transcriptLineStartOffset = lineEndOffset + lineBreakBytes;
      if (line.trim().length > 0) {
        this.processTranscriptLine(turn, line, lineStartOffset);
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
    this.failActiveTurn(
      turn,
      `Claude transcript JSONL line exceeded ${MAX_TRANSCRIPT_LINE_BYTES} bytes (observed ${observedBytes}).`,
    );
  }

  private transitionTurnPhase(turn: ActiveTurnState, next: TurnPhase): void {
    const current = turn.phase;
    const advanced = advanceTurnPhase(current, next);
    if (advanced === current) {
      return;
    }
    const now = Date.now();
    turn.phase = advanced;
    turn.phaseEnteredAt = now;
    if (advanced !== 'terminal') {
      this.recordSemanticProgressAt(turn, now);
    }
  }

  private recordSemanticProgress(turn: ActiveTurnState): void {
    this.recordSemanticProgressAt(turn, Date.now());
  }

  private recordSemanticProgressAt(turn: ActiveTurnState, now: number): void {
    turn.lastSemanticProgressAt = now;
    turn.replacementAttempts = 0;
    turn.continuationSentAt = null;
    turn.continuationPhase = null;
  }

  private processTranscriptLine(turn: ActiveTurnState, line: string, lineStartOffset: number): void {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(row)) {
      return;
    }

    const sessionId = readSessionId(row);
    if (row.type === 'user') {
      this.handleUserTranscriptRow(turn, row, lineStartOffset, sessionId);
      return;
    }

    if (row.type === 'assistant') {
      this.handleAssistantTranscriptRow(turn, row, sessionId);
      return;
    }
    this.maybeUpdateSessionId(sessionId);
    if (row.type === 'system') {
      this.handleSystemTranscriptRow(turn, row);
    }
  }

  private handleUserTranscriptRow(
    turn: ActiveTurnState,
    row: Record<string, unknown>,
    lineStartOffset: number,
    sessionId: string | null,
  ): void {
    if (!this.isCurrentTurnPromptRegistration(turn, row, lineStartOffset, sessionId)) {
      return;
    }
    this.transitionTurnPhase(turn, 'registered');
  }

  private isCurrentTurnPromptRegistration(
    turn: ActiveTurnState,
    row: Record<string, unknown>,
    lineStartOffset: number,
    sessionId: string | null,
  ): boolean {
    if (turn.phase !== 'sent') {
      return false;
    }
    if (lineStartOffset < turn.promptTranscriptOffset) {
      return false;
    }
    if (sessionId !== null && sessionId !== this.currentConversationRef()) {
      return false;
    }
    const message = isRecord(row.message) ? row.message : null;
    if (message === null || message.role !== 'user') {
      return false;
    }
    const text = readUserMessageText(message.content);
    if (text === null) {
      return false;
    }
    return hashPromptText(text) === turn.promptTextHash;
  }

  private handleAssistantTranscriptRow(
    turn: ActiveTurnState,
    row: Record<string, unknown>,
    sessionId: string | null,
  ): void {
    if (turn.phase === 'ending' || turn.phase === 'terminal') {
      return;
    }

    this.maybeUpdateSessionId(sessionId);
    const message = isRecord(row.message) ? row.message : null;
    if (message === null) {
      return;
    }
    if (turn.phase === 'sent' || turn.phase === 'registered' || turn.phase === 'responding') {
      this.transitionTurnPhase(turn, 'responding');
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
      this.transitionTurnPhase(turn, 'ending');
    } else {
      this.recordSemanticProgress(turn);
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

    this.transitionTurnPhase(turn, 'terminal');
    this.activeTurn = null;
    this.lastTerminalTurnId = turn.brokerTurnId;
    this.emitNotification({
      method: 'turn/completed',
      params: completed,
    });
  }

  private failActiveTurn(turn: ActiveTurnState, message: string): void {
    if (this.activeTurn !== turn) {
      return;
    }
    if (turn.phase === 'terminal') {
      return;
    }
    const failedAt = Date.now();
    const failurePhase = turn.phase;
    this.transitionTurnPhase(turn, 'terminal');
    this.activeTurn = null;
    this.lastTerminalTurnId = turn.brokerTurnId;
    this.emitTurnFailure(turn, message, failurePhase, failedAt);
  }

  private handleChildExit(binding: ChildBinding, event: ChildExit): void {
    binding.dispose();
    if (this.childBinding === binding) {
      this.childBinding = null;
      this.initialized = false;
    }

    if (this.shuttingDown || binding.expectedExit) {
      return;
    }

    const turn = this.activeTurn;
    if (turn) {
      this.failActiveTurn(turn, this.childExitError(event).message);
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

    this.failActiveTurn(turn, 'Claude turn interrupted.');
  }

  private sendTuiPrompt(prompt: string): void {
    this.writeToChild(bracketedPaste(prompt));
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
    const expectedFilename = `${conversationRef}.jsonl`;
    if (
      this.transcriptPath !== null &&
      basename(this.transcriptPath) === expectedFilename &&
      existsSync(this.transcriptPath)
    ) {
      return this.transcriptPath;
    }
    this.transcriptPath = null;

    // The daemon preserves CLAUDE_CONFIG_DIR and forwards it to spawned `claude`
    // children, so their session logs land under the same config dir we read here.
    const projectsRoot = join(resolveClaudeConfigDir(process.env.CLAUDE_CONFIG_DIR, homedir()), 'projects');
    try {
      let match: string | null = null;
      const projectEntries = readdirSync(projectsRoot, { withFileTypes: true });
      for (const entry of projectEntries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const candidate = join(projectsRoot, entry.name, expectedFilename);
        if (existsSync(candidate)) {
          if (match !== null) {
            return null;
          }
          match = candidate;
        }
      }
      this.transcriptPath = match;
      return match;
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

  private emitTurnFailure(
    turn: ActiveTurnState,
    message: string,
    phase: ActiveTurnFailurePhase,
    failedAt: number,
  ): void {
    const diagnostic = this.buildTurnFailureDiagnostic(turn, message, phase, failedAt);
    this.emitNotification({
      method: 'turn/failed',
      params: {
        brokerTurnId: turn.brokerTurnId,
        message,
        sessionId: this.latestSessionId,
        conversationRef: this.currentConversationRef(),
        diagnostic,
      },
    });
  }

  private buildTurnFailureDiagnostic(
    turn: ActiveTurnState,
    message: string,
    phase: ActiveTurnFailurePhase,
    failedAt: number,
  ): TurnFailureDiagnostic {
    const childOutputTail = this.outputRing;
    return {
      schemaVersion: TURN_FAILURE_DIAGNOSTIC_SCHEMA_VERSION,
      reason: this.turnFailureReason(message, phase, childOutputTail),
      phase,
      idleMs: this.turnFailureIdleMs(turn, phase, failedAt),
      attempts: this.turnFailureAttempts(turn, phase),
      childOutputTail,
      transcriptTail: this.readTranscriptTail(),
      sessionId: nonEmptyOrNull(this.latestSessionId),
      conversationRef: nonEmptyOrNull(this.currentConversationRef()),
    };
  }

  private turnFailureReason(
    message: string,
    phase: ActiveTurnFailurePhase,
    childOutputTail: string,
  ): TurnFailureDiagnosticReason {
    if (phase === 'ending') {
      return 'finalization-failure';
    }
    if (message.includes('interrupted')) {
      return 'interrupted';
    }
    if (containsClaudeApiError(message) || containsClaudeApiError(childOutputTail)) {
      return 'api-error';
    }
    // These substrings are produced by this controller's child-exit paths above;
    // matching them keeps the diagnostic reason stable without parsing RPC text.
    if (message.includes('child exited') || message.includes('child failed')) {
      return 'child-exit';
    }
    if (phase === 'sent' || phase === 'registered' || phase === 'responding') {
      return 'silent-hang';
    }
    return 'internal-error';
  }

  private turnFailureIdleMs(turn: ActiveTurnState, phase: ActiveTurnFailurePhase, failedAt: number): number {
    let idleStartedAt: number;
    switch (phase) {
      case 'sent':
        idleStartedAt = turn.lastPromptSentAt === 0 ? turn.startedAt : turn.lastPromptSentAt;
        break;
      case 'registered':
        idleStartedAt = turn.continuationSentAt ?? turn.phaseEnteredAt;
        break;
      case 'responding':
        idleStartedAt = turn.continuationSentAt ?? turn.lastSemanticProgressAt;
        break;
      case 'ending':
        idleStartedAt = turn.phaseEnteredAt;
        break;
    }
    return Math.max(0, Math.floor(failedAt - idleStartedAt));
  }

  private turnFailureAttempts(turn: ActiveTurnState, phase: TurnFailureDiagnosticPhase): number {
    if (phase === 'sent') {
      return Math.max(0, turn.promptSendAttempts - 1);
    }
    return Math.max(0, turn.replacementAttempts);
  }

  private readTranscriptTail(): string {
    const path = this.resolveTranscriptPath();
    return path === null ? '' : readFileTail(path, this.outputLimit);
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

function hashPromptText(prompt: string): string {
  return sha256Hex(normalizePromptText(prompt));
}

function normalizePromptText(prompt: string): string {
  return prompt.replace(/\r\n?/g, '\n');
}

function readUserMessageText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }

  const textParts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === 'tool_result') {
      return null;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    }
  }

  return textParts.length > 0 ? textParts.join('') : null;
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

function readFileTail(path: string, limit: number): string {
  if (limit <= 0) {
    return '';
  }

  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, limit);
    if (length === 0) {
      return '';
    }
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
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

function containsClaudeApiError(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes('api error') ||
    normalized.includes('apierror') ||
    normalized.includes('anthropic api') ||
    normalized.includes('rate limit') ||
    normalized.includes('429') ||
    normalized.includes('529')
  );
}

function nonEmptyOrNull(value: string | null): string | null {
  if (value === null || value.length === 0) {
    return null;
  }
  return value;
}
