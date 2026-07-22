import { errorMessage } from '../../infra/error-format.js';
import { readString } from '../../infra/json.js';
import type { TimePort } from '../../infra/port-types.js';
import { resolveModelTier } from '../request-policy.js';
import type {
  Provider,
  ProviderEventBody,
  ProviderRequest,
  ProviderRuntime,
  ProviderServerLease,
} from '../contract.js';
import { bindAppServerNotificationHandler, buildProviderFailureMessage, requireAppServerLease } from '../app-server.js';
import type { AppServerNotificationMessage } from '../protocol.js';
import { streamProviderEvents } from '../stream.js';
import { buildJobDiagnostics, buildJobTerminal } from '../terminal.js';
import { normalizeCodexUsage, type CodexTokenUsage } from './usage.js';
import {
  buildCodexContinuity,
  isCodexSessionUnavailable,
  mapRecoveryContinuationTurnStartParams,
  mapThreadResumeParams,
  mapThreadStartParams,
  mapTurnStartParams,
  readCodexPersistedContinuity,
  resolveCodexServiceTier,
  type CodexServiceTier,
} from './request-mapping.js';
import type { AppServerMethod, AppServerRequestParams, AppServerResponse, Turn, TurnStartParams } from './protocol.js';
import { locateCodexRolloutArtifactFromRuntime } from './artifacts.js';
import { verifyCodexEffectiveTransport } from './transport-policy.js';
import {
  recoverableTurnFailure,
  recoverableTurnFailureFromInfo,
  readErrorNotificationEvidence,
  turnFailureMessage,
  type ErrorNotificationEvidence,
  type RecoverableTurnFailure,
} from './turn-recovery.js';
import type { CodexExecutionContext } from './execution-context.js';

type CodexProviderRuntime = ProviderRuntime<CodexExecutionContext>;

const INFERRED_COMPLETION_DELAY_MS = 250;
export const PRE_TURN_MAILBOX_CAP = 64;

// Sentinel exit code surfaced when the Codex app-server reports a turn failure
// over RPC instead of the wrapper observing a process exit. Codex thread-kernel
// drives a long-running app-server lease, so no real OS exit code is available;
// the diagnostic message goes into `note`. See spec §7.1 `provider_exit`.
const CODEX_RPC_FAILURE_EXIT_CODE = 1;

type PreTurnMailboxStatus = {
  pending: number;
  dropped: number;
};

type CodexKernelResult =
  | {
      kind: 'completed';
      turn: Turn;
      source: 'notification' | 'start_response' | 'inferred';
      attempt: TurnAttempt;
    }
  | { kind: 'failed'; message: string; preserveRecoverySnapshot?: boolean; attempt?: TurnAttempt }
  | { kind: 'aborted'; reason: 'signal_abort'; preserveRecoverySnapshot?: boolean; attempt?: TurnAttempt };

export type TurnAttempt = {
  sequence: number;
  lifecycle: 'starting' | 'active' | 'settled';
  turnId: string | null;
  turnStartRequested: boolean;
  startSettled: boolean;
  checkpointedTurnId: string | null;
  bufferedNotifications: AppServerNotificationMessage[];
  bufferedNotificationsDropped: number;
  completion: Promise<CodexKernelResult>;
  resolveCompletion: (result: CodexKernelResult) => void;
  idReady: Promise<string>;
  resolveIdReady: (turnId: string) => void;
  finalTurn: Turn | null;
  completed: boolean;
  finalAnswerSeen: boolean;
  awaitingExplicitCompletion: boolean;
  terminalErrors: ErrorNotificationEvidence[];
  pendingCollaborations: Set<string>;
  subagentThreadIds: Set<string>;
  activeSubagentTurns: Set<string>;
  completionTimer: ReturnType<TimePort['setTimeout']> | null;
  interruptRequest: Promise<'confirmed' | 'failed'> | null;
};

export type CodexTurnState = {
  startedAt: number;
  cwd: string;
  model: string | undefined;
  serviceTier: CodexServiceTier | undefined;
  sessionId: string;
  persistedThreadId: string | null;
  mailboxThreadCandidates: Set<string>;
  threadId: string | null;
  threadIds: Set<string>;
  subagentTurnIds: Map<string, string>;
  retiredControllerTurnIds: Set<string>;
  activeAttempt: TurnAttempt;
  continuityBridge: CodexProviderRuntime['continuityBridge'];
  signal: AbortSignal;
  lease: ProviderServerLease | null;
  artifactHandleEmissionAttempted: boolean;
  artifactLocatorRuntime: Pick<CodexProviderRuntime, 'providerContext' | 'storage'>;
  preTurnMailbox: {
    status(): PreTurnMailboxStatus;
  };
  lastAgentMessage: string;
  latestTokenCount: CodexTokenUsage | null;
  finalErrorMessage: string | undefined;
  finalized: boolean;
  time: Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout'>;
};

const codexInterruptBindings = new WeakMap<ProviderServerLease, CodexTurnState>();

function bindCodexInterruptState(lease: ProviderServerLease, state: CodexTurnState): () => void {
  codexInterruptBindings.set(lease, state);
  return () => {
    if (codexInterruptBindings.get(lease) === state) {
      codexInterruptBindings.delete(lease);
    }
  };
}

function createAttempt(sequence: number): TurnAttempt {
  let resolveCompletion!: (result: CodexKernelResult) => void;
  const completion = new Promise<CodexKernelResult>((resolve) => {
    resolveCompletion = resolve;
  });
  let resolveIdReady!: (turnId: string) => void;
  const idReady = new Promise<string>((resolve) => {
    resolveIdReady = resolve;
  });

  return {
    sequence,
    lifecycle: 'starting',
    turnId: null,
    turnStartRequested: false,
    startSettled: false,
    checkpointedTurnId: null,
    bufferedNotifications: [],
    bufferedNotificationsDropped: 0,
    completion,
    resolveCompletion,
    idReady,
    resolveIdReady,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    awaitingExplicitCompletion: false,
    terminalErrors: [],
    pendingCollaborations: new Set(),
    subagentThreadIds: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    interruptRequest: null,
  };
}

function createState(request: ProviderRequest, runtime: CodexProviderRuntime): CodexTurnState {
  const persistedContinuity = readCodexPersistedContinuity(runtime.persistedContinuity);
  const mailboxThreadCandidates = new Set<string>();
  const persistedThreadId = persistedContinuity.threadId ?? null;
  const requestConversationRef = readString(request.conversationRef);
  if (persistedThreadId !== null) {
    mailboxThreadCandidates.add(persistedThreadId);
  }
  if (requestConversationRef !== undefined) {
    mailboxThreadCandidates.add(requestConversationRef);
  }

  const state = {
    startedAt: runtime.time.now(),
    cwd: persistedContinuity.cwd ?? request.cwd,
    model: resolveModelTier(request.model),
    serviceTier: resolveCodexServiceTier(request, runtime),
    sessionId: request.sessionId,
    persistedThreadId,
    mailboxThreadCandidates,
    threadId: null,
    threadIds: new Set(),
    subagentTurnIds: new Map(),
    retiredControllerTurnIds: new Set(),
    activeAttempt: createAttempt(0),
    continuityBridge: runtime.continuityBridge,
    signal: runtime.signal,
    lease: null,
    artifactHandleEmissionAttempted: false,
    artifactLocatorRuntime: {
      providerContext: runtime.providerContext,
      storage: runtime.storage,
    },
    preTurnMailbox: {
      status: () => ({
        pending: 0,
        dropped: 0,
      }),
    },
    lastAgentMessage: '',
    latestTokenCount: null,
    finalErrorMessage: undefined,
    finalized: false,
    time: runtime.time,
  } satisfies CodexTurnState;

  state.preTurnMailbox = {
    status: () => ({
      pending: state.activeAttempt.bufferedNotifications.length,
      dropped: state.activeAttempt.bufferedNotificationsDropped,
    }),
  };

  return state;
}

function requireResumeConversationRef(request: ProviderRequest): string {
  const conversationRef = readString(request.conversationRef);
  if (conversationRef === undefined) {
    throw new Error('resume requires conversationRef');
  }
  return conversationRef;
}

function emitProgress(emit: (event: ProviderEventBody) => void, message: string | null | undefined): void {
  if (!message) {
    return;
  }

  emit({
    kind: 'progress',
    message,
  });
}

function emitCodexRolloutArtifactHandleOnce(state: CodexTurnState, emit: (event: ProviderEventBody) => void): void {
  if (state.artifactHandleEmissionAttempted || state.threadId === null) {
    return;
  }
  state.artifactHandleEmissionAttempted = true;

  const result = locateCodexRolloutArtifactFromRuntime(state.threadId, state.artifactLocatorRuntime);
  if (!result) {
    return;
  }
  if (result.kind === 'match') {
    emit({
      kind: 'artifact_handle',
      handle: result.artifact.handle,
      identity: result.artifact.identity,
    });
    return;
  }

  emitProgress(emit, result.diagnostic);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractThreadId(message: AppServerNotificationMessage): string | null {
  return readString((message as { params?: { threadId?: unknown } }).params?.threadId) ?? null;
}

function extractTurnId(message: AppServerNotificationMessage): string | null {
  const params = (message as { params?: { turnId?: unknown; turn?: { id?: unknown } } }).params;
  return readString(params?.turnId) ?? readString(params?.turn?.id) ?? null;
}

function readTurnId(turn: { id?: unknown } | null | undefined): string | null {
  return readString(turn?.id) ?? null;
}

function canonicalTurn(turn: Turn, fallbackId: string | null): Turn {
  const turnId = readTurnId(turn) ?? fallbackId ?? 'inferred-turn';
  return turn.id === turnId ? turn : { ...turn, id: turnId };
}

function claimControllerTurnId(state: CodexTurnState, attempt: TurnAttempt, turnId: string): boolean {
  if (state.finalized || state.activeAttempt !== attempt || attempt.completed) {
    return false;
  }
  if (attempt.turnId !== null) {
    if (attempt.turnId === turnId) {
      return true;
    }
    settleAttempt(state, attempt, {
      kind: 'failed',
      message: `Codex turn/start id mismatch: claimed ${attempt.turnId}, received ${turnId}.`,
      preserveRecoverySnapshot: true,
      attempt,
    });
    return false;
  }
  if (state.retiredControllerTurnIds.has(turnId)) {
    settleAttempt(state, attempt, {
      kind: 'failed',
      message: `Codex turn/start reused retired turn id ${turnId}.`,
      preserveRecoverySnapshot: true,
      attempt,
    });
    return false;
  }
  attempt.turnId = turnId;
  attempt.resolveIdReady(turnId);
  if (state.threadId !== null && attempt.checkpointedTurnId !== turnId) {
    checkpoint(state, state.threadId, turnId);
    attempt.checkpointedTurnId = turnId;
  }
  if (state.signal.aborted && state.lease !== null) {
    void ensureInterrupt(state.lease, state, attempt);
  }
  return true;
}

function registerThread(state: CodexTurnState, threadId: string | null): void {
  if (threadId === null) {
    return;
  }
  state.threadIds.add(threadId);
}

function registerMailboxThreadCandidate(state: CodexTurnState, threadId: string | null): void {
  if (threadId === null) {
    return;
  }
  state.mailboxThreadCandidates.add(threadId);
}

function canAdmitNotification(state: CodexTurnState, message: AppServerNotificationMessage): boolean {
  const threadId = extractThreadId(message);
  if (threadId === null) {
    return true;
  }
  return threadId === state.threadId || state.mailboxThreadCandidates.has(threadId);
}

function admitBufferedNotification(state: CodexTurnState, message: AppServerNotificationMessage): boolean {
  if (!canAdmitNotification(state, message)) {
    return false;
  }
  const attempt = state.activeAttempt;
  if (attempt.bufferedNotifications.length >= PRE_TURN_MAILBOX_CAP) {
    attempt.bufferedNotifications.shift();
    attempt.bufferedNotificationsDropped += 1;
  }
  attempt.bufferedNotifications.push(message);
  return true;
}

function clearCompletionTimer(state: CodexTurnState, attempt = state.activeAttempt): void {
  if (!attempt.completionTimer) {
    return;
  }
  state.time.clearTimeout(attempt.completionTimer);
  attempt.completionTimer = null;
}

function settleAttempt(state: CodexTurnState, attempt: TurnAttempt, result: CodexKernelResult): void {
  if (state.finalized || state.activeAttempt !== attempt || attempt.completed) {
    return;
  }
  clearCompletionTimer(state, attempt);
  attempt.completed = true;
  attempt.lifecycle = 'settled';
  attempt.resolveCompletion(result);
}

function completeTurn(
  state: CodexTurnState,
  attempt: TurnAttempt,
  turn: Turn | null = null,
  source: 'notification' | 'start_response' | 'inferred' = turn === null ? 'inferred' : 'notification',
): void {
  if (state.finalized || state.activeAttempt !== attempt || attempt.completed) {
    return;
  }
  if (turn) {
    const turnId = readTurnId(turn);
    attempt.finalTurn = canonicalTurn(turn, attempt.turnId);
    if (turnId !== null && attempt.turnId === null) {
      attempt.turnId = turnId;
      attempt.resolveIdReady(turnId);
    }
  } else {
    attempt.finalTurn ??= {
      id: attempt.turnId ?? 'inferred-turn',
      status: 'completed',
    };
  }
  settleAttempt(state, attempt, {
    kind: 'completed',
    turn: attempt.finalTurn,
    source,
    attempt,
  });
}

function scheduleInferredCompletion(state: CodexTurnState, attempt = state.activeAttempt): void {
  if (
    state.activeAttempt !== attempt ||
    state.finalized ||
    attempt.completed ||
    attempt.finalTurn ||
    !attempt.finalAnswerSeen ||
    attempt.awaitingExplicitCompletion
  ) {
    return;
  }
  if (attempt.pendingCollaborations.size > 0 || attempt.activeSubagentTurns.size > 0) {
    return;
  }

  clearCompletionTimer(state, attempt);
  attempt.completionTimer = state.time.setTimeout(() => {
    attempt.completionTimer = null;
    if (
      state.activeAttempt !== attempt ||
      state.finalized ||
      attempt.completed ||
      attempt.finalTurn ||
      !attempt.finalAnswerSeen ||
      attempt.awaitingExplicitCompletion
    ) {
      return;
    }
    if (attempt.pendingCollaborations.size > 0 || attempt.activeSubagentTurns.size > 0) {
      return;
    }
    completeTurn(state, attempt);
  }, INFERRED_COMPLETION_DELAY_MS);
  attempt.completionTimer.unref?.();
}

function belongsToTurn(state: CodexTurnState, message: AppServerNotificationMessage): boolean {
  const messageThreadId = extractThreadId(message);
  if (messageThreadId === null || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const messageTurnId = extractTurnId(message);
  if (messageTurnId !== null && state.retiredControllerTurnIds.has(messageTurnId)) {
    return false;
  }
  const attempt = state.activeAttempt;
  if (messageThreadId === state.threadId) {
    return attempt.turnId === null || attempt.turnId === messageTurnId;
  }
  if (!attempt.subagentThreadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.subagentTurnIds.get(messageThreadId) ?? null;
  return trackedTurnId === null || trackedTurnId === messageTurnId;
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null || value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function shorten(text: unknown, limit = 72): string {
  const normalized = stringifyValue(text).trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return '';
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function describeStartedItem(item: Record<string, unknown>): string | null {
  switch (item.type) {
    case 'commandExecution':
      return `Running command: ${shorten(item.command, 96)}`;
    case 'fileChange':
      return `Applying ${Array.isArray(item.changes) ? item.changes.length : 0} file change(s).`;
    case 'mcpToolCall':
      return `Calling ${item.server}/${item.tool}.`;
    case 'dynamicToolCall':
      return `Running tool: ${item.tool}.`;
    case 'webSearch':
      return `Searching: ${shorten(item.query, 96)}`;
    default:
      return null;
  }
}

function describeCompletedItem(item: Record<string, unknown>): string | null {
  switch (item.type) {
    case 'commandExecution': {
      const exitCode = item.exitCode ?? '?';
      const status = item.status === 'completed' ? 'completed' : item.status;
      return `Command ${stringifyValue(status)}: ${shorten(item.command, 96)} (exit ${stringifyValue(exitCode)})`;
    }
    case 'fileChange':
      return `File changes ${item.status}.`;
    case 'mcpToolCall':
      return `Tool ${item.server}/${item.tool} ${item.status}.`;
    case 'dynamicToolCall':
      return `Tool ${item.tool} ${item.status}.`;
    default:
      return null;
  }
}

function recordItem(
  state: CodexTurnState,
  attempt: TurnAttempt,
  item: Record<string, unknown>,
  lifecycle: 'started' | 'completed',
  threadId: string | null,
): void {
  if (item.type === 'collabAgentToolCall') {
    const itemId = typeof item.id === 'string' ? item.id : null;
    if (threadId === state.threadId && itemId) {
      if (lifecycle === 'started' || item.status === 'inProgress') {
        attempt.pendingCollaborations.add(itemId);
      } else if (lifecycle === 'completed') {
        attempt.pendingCollaborations.delete(itemId);
        scheduleInferredCompletion(state, attempt);
      }
    }
    if (Array.isArray(item.receiverThreadIds)) {
      for (const receiverThreadId of item.receiverThreadIds) {
        const receiverId = readString(receiverThreadId) ?? null;
        registerThread(state, receiverId);
        if (receiverId !== null) {
          attempt.subagentThreadIds.add(receiverId);
        }
      }
    }
    return;
  }

  if (item.type === 'agentMessage') {
    if (threadId === null || threadId === state.threadId) {
      if (typeof item.text === 'string' && item.text.length > 0) {
        state.lastAgentMessage = item.text;
      }
      if (lifecycle === 'completed' && item.phase === 'final_answer') {
        attempt.finalAnswerSeen = true;
        scheduleInferredCompletion(state, attempt);
      }
    }
  }
}

function handleItemNotification(
  state: CodexTurnState,
  attempt: TurnAttempt,
  notification: { params?: Record<string, unknown> },
  lifecycle: 'started' | 'completed',
  describe: (item: Record<string, unknown>) => string | null,
  emit: (event: ProviderEventBody) => void,
): void {
  const params = notification.params as { item?: Record<string, unknown>; threadId?: unknown } | undefined;
  if (!params?.item) {
    return;
  }

  recordItem(state, attempt, params.item, lifecycle, readString(params.threadId) ?? null);
  emitProgress(emit, describe(params.item));
}

function applyNotificationCore(
  state: CodexTurnState,
  attempt: TurnAttempt,
  message: AppServerNotificationMessage,
  emit: (event: ProviderEventBody) => void,
): void {
  const notification = message as { method: string; params?: Record<string, unknown> };

  switch (notification.method) {
    case 'thread/started': {
      const thread = notification.params?.thread as { id?: unknown } | undefined;
      registerThread(state, readString(thread?.id) ?? null);
      return;
    }
    case 'thread/name/updated':
      registerThread(state, extractThreadId(message));
      return;
    case 'turn/started': {
      const threadId = extractThreadId(message);
      const turnId = extractTurnId(message);
      registerThread(state, threadId);
      if (threadId === state.threadId && turnId !== null) {
        claimControllerTurnId(state, attempt, turnId);
      } else if (threadId !== null && turnId !== null && attempt.subagentThreadIds.has(threadId)) {
        state.subagentTurnIds.set(threadId, turnId);
        attempt.activeSubagentTurns.add(threadId);
      }
      emitProgress(emit, `Turn started (${turnId ?? 'unknown'}).`);
      return;
    }
    case 'item/started':
      handleItemNotification(state, attempt, notification, 'started', describeStartedItem, emit);
      return;
    case 'item/completed':
      handleItemNotification(state, attempt, notification, 'completed', describeCompletedItem, emit);
      return;
    case 'thread/tokenUsage/updated': {
      if (extractThreadId(message) !== state.threadId || extractTurnId(message) !== attempt.turnId) {
        return;
      }
      const total = readThreadTokenUsageTotal(message);
      if (total !== null) {
        state.latestTokenCount = total;
      }
      return;
    }
    case 'error': {
      const evidence = readErrorNotificationEvidence(message);
      if (
        evidence === null ||
        evidence.threadId !== state.threadId ||
        evidence.turnId !== attempt.turnId ||
        state.activeAttempt !== attempt
      ) {
        return;
      }
      attempt.awaitingExplicitCompletion = true;
      clearCompletionTimer(state, attempt);
      if (!evidence.willRetry) {
        attempt.terminalErrors.push(evidence);
      }
      if (recoverableTurnFailureFromInfo(evidence.info) === null) {
        emitProgress(emit, `Codex error: ${evidence.message ?? 'unknown error'}`);
      }
      return;
    }
    case 'turn/completed': {
      const threadId = extractThreadId(message);
      const turnId = extractTurnId(message);
      const turn = (notification.params as { turn?: Turn } | undefined)?.turn ?? null;
      if (threadId !== null && threadId !== state.threadId) {
        attempt.activeSubagentTurns.delete(threadId);
        scheduleInferredCompletion(state, attempt);
        return;
      }
      if (threadId !== state.threadId || turnId === null || turnId !== attempt.turnId || turn === null) {
        return;
      }
      completeTurn(state, attempt, turn, 'notification');
      return;
    }
    default:
      return;
  }
}

function maybeDiscoverTurnId(state: CodexTurnState, message: AppServerNotificationMessage): void {
  if (message.method !== 'turn/started') {
    return;
  }
  const attempt = state.activeAttempt;
  const threadId = extractThreadId(message);
  const turnId = extractTurnId(message);
  if (threadId === null || turnId === null || state.threadId === null || threadId !== state.threadId) {
    return;
  }
  claimControllerTurnId(state, attempt, turnId);
}

// Codex v2 reports cumulative token usage via the native `thread/tokenUsage/updated`
// notification (params.tokenUsage.total, a camelCase TokenUsageBreakdown). This is a
// stable notification — it needs no experimentalRawEvents flag or experimentalApi
// capability. `total` is cumulative for the turn, so last-write-wins is correct.
function readThreadTokenUsageTotal(message: AppServerNotificationMessage): CodexTokenUsage | null {
  if (message.method !== 'thread/tokenUsage/updated') {
    return null;
  }
  const params = (message as { params?: { tokenUsage?: { total?: unknown } } }).params;
  const total = params?.tokenUsage?.total;
  return isRecord(total) ? total : null;
}

function deliverNotification(
  state: CodexTurnState,
  attempt: TurnAttempt,
  message: AppServerNotificationMessage,
  emit: (event: ProviderEventBody) => void,
): void {
  if (message.method === 'thread/started' || message.method === 'thread/name/updated') {
    applyNotificationCore(state, attempt, message, emit);
    return;
  }
  if (message.method === 'turn/started') {
    const threadId = extractThreadId(message);
    const turnId = extractTurnId(message);
    if (
      state.activeAttempt === attempt &&
      !attempt.completed &&
      turnId !== null &&
      (threadId === state.threadId || (threadId !== null && attempt.subagentThreadIds.has(threadId)))
    ) {
      applyNotificationCore(state, attempt, message, emit);
    }
    return;
  }
  if (state.activeAttempt !== attempt || attempt.completed || !belongsToTurn(state, message)) {
    return;
  }
  applyNotificationCore(state, attempt, message, emit);
}

function flushBufferedNotifications(
  state: CodexTurnState,
  attempt: TurnAttempt,
  emit: (event: ProviderEventBody) => void,
): void {
  if (
    state.activeAttempt !== attempt ||
    attempt.completed ||
    attempt.turnId === null ||
    !attempt.startSettled ||
    attempt.bufferedNotifications.length === 0
  ) {
    return;
  }
  const buffered = attempt.bufferedNotifications.splice(0, attempt.bufferedNotifications.length);
  for (const message of buffered) {
    deliverNotification(state, attempt, message, emit);
    if (attempt.completed) {
      break;
    }
  }
}

function checkpoint(state: CodexTurnState, threadId: string, turnId?: string): void {
  state.continuityBridge.checkpoint({
    conversationRef: threadId,
    resumable: true,
    providerContinuity: buildCodexContinuity({
      cwd: state.cwd,
      threadId,
      turnId,
    }),
  });
}

async function rpc<M extends AppServerMethod>(
  lease: ProviderServerLease,
  method: M,
  params: AppServerRequestParams<M>,
): Promise<AppServerResponse<M>> {
  return lease.rpc<AppServerResponse<M>>(method, params as unknown as Record<string, unknown>);
}

async function interruptTurn(lease: ProviderServerLease, threadId: string, turnId: string): Promise<void> {
  await rpc(lease, 'turn/interrupt', { threadId, turnId });
}

export async function mapCodexInterrupt(lease: ProviderServerLease): Promise<void> {
  const state = codexInterruptBindings.get(lease);
  const attempt = state?.activeAttempt;
  if (!state || !attempt || attempt.lifecycle === 'settled' || state.threadId === null || attempt.turnId === null) {
    return;
  }

  await ensureInterrupt(lease, state, attempt);
}

function ensureInterrupt(
  lease: ProviderServerLease,
  state: CodexTurnState,
  attempt: TurnAttempt,
): Promise<'confirmed' | 'failed'> {
  if (state.threadId === null || attempt.turnId === null) {
    return Promise.resolve('failed');
  }
  attempt.interruptRequest ??= interruptTurn(lease, state.threadId, attempt.turnId).then(
    () => 'confirmed' as const,
    () => 'failed' as const,
  );
  return attempt.interruptRequest;
}

async function initializeThread(
  request: ProviderRequest,
  runtime: CodexProviderRuntime,
  lease: ProviderServerLease,
  state: CodexTurnState,
  emit: (event: ProviderEventBody) => void,
): Promise<void> {
  await verifyCodexEffectiveTransport(lease, request.cwd);
  let threadId: string;

  if (request.action === 'resume') {
    const conversationRef = requireResumeConversationRef(request);
    try {
      const response = await rpc(
        lease,
        'thread/resume',
        mapThreadResumeParams(request, conversationRef, state.serviceTier),
      );
      threadId = requireRpcThreadId(response, 'thread/resume');
    } catch (error) {
      if (isCodexSessionUnavailable(error)) {
        throw new Error(
          `Conversation ${conversationRef} is no longer resumable because the saved thread is missing or invalid.`,
          { cause: error },
        );
      }
      throw error;
    }
  } else {
    const response = await rpc(lease, 'thread/start', mapThreadStartParams(request, state.serviceTier));
    threadId = requireRpcThreadId(response, 'thread/start');
  }

  state.threadId = threadId;
  registerMailboxThreadCandidate(state, threadId);
  registerThread(state, threadId);
  checkpoint(state, threadId);
  emitProgress(emit, `Thread ready (${threadId}).`);
}

function requireRpcThreadId(response: { thread?: { id?: unknown } }, method: 'thread/resume' | 'thread/start'): string {
  const threadId = readString(response.thread?.id);
  if (threadId === undefined) {
    throw new Error(`Codex ${method} response did not include a non-empty thread id.`);
  }
  return threadId;
}

async function startTurn(
  runtime: CodexProviderRuntime,
  lease: ProviderServerLease,
  state: CodexTurnState,
  attempt: TurnAttempt,
  params: TurnStartParams,
  emit: (event: ProviderEventBody) => void,
): Promise<CodexKernelResult | null> {
  attempt.turnStartRequested = true;
  if (runtime.signal.aborted) {
    return { kind: 'aborted', reason: 'signal_abort', attempt };
  }
  if (state.threadId === null) {
    throw new Error('Codex thread id missing before turn/start.');
  }

  const aborted = abortResultPromise(lease, runtime, state, attempt);
  const startOutcome = rpc(lease, 'turn/start', params).then(
    (response) => ({ kind: 'response' as const, response }),
    (error: unknown) => ({ kind: 'rpc_error' as const, error }),
  );
  const closedOutcome = lease.closed.then((closed) => ({
    kind: 'closed' as const,
    closed,
  }));
  const attemptOutcome = attempt.completion.then((result) => ({
    kind: 'attempt' as const,
    result,
  }));

  let startResult:
    | Awaited<typeof startOutcome>
    | Awaited<typeof closedOutcome>
    | Awaited<typeof attemptOutcome>
    | { kind: 'aborted'; result: CodexKernelResult };
  try {
    startResult = await Promise.race([
      startOutcome,
      closedOutcome,
      attemptOutcome,
      aborted.promise.then((result) => ({ kind: 'aborted' as const, result })),
    ]);
  } finally {
    aborted.cleanup();
  }

  if (startResult.kind === 'attempt' || startResult.kind === 'aborted') {
    return startResult.result;
  }
  if (startResult.kind === 'closed') {
    return transportClosedResult(runtime, attempt, startResult.closed);
  }
  if (startResult.kind === 'rpc_error') {
    if (attempt.completed) {
      return attempt.completion;
    }
    const error = startResult.error;
    if (runtime.signal.aborted) {
      if (attempt.turnId !== null) {
        return await finishAbortedStart(lease, runtime, state, attempt);
      }
      return { kind: 'aborted', reason: 'signal_abort', attempt };
    }
    return {
      kind: 'failed',
      message: errorMessage(error),
      preserveRecoverySnapshot: attempt.turnId !== null,
      attempt,
    };
  }
  const response: AppServerResponse<'turn/start'> = startResult.response;
  attempt.startSettled = true;
  const responseTurnId = readTurnId(response.turn);
  if (responseTurnId !== null && !claimControllerTurnId(state, attempt, responseTurnId)) {
    return attempt.completion;
  }

  flushBufferedNotifications(state, attempt, emit);
  if (attempt.completed) {
    return attempt.completion;
  }

  if (runtime.signal.aborted) {
    if (attempt.turnId === null) {
      const discovered = await Promise.race([
        attempt.idReady.then(() => 'id' as const),
        lease.closed.then(() => 'closed' as const),
      ]);
      if (discovered === 'closed') {
        return { kind: 'aborted', reason: 'signal_abort', attempt };
      }
    }
    return await finishAbortedStart(lease, runtime, state, attempt);
  }

  if (response.turn?.status && response.turn.status !== 'inProgress') {
    completeTurn(state, attempt, response.turn, 'start_response');
    return attempt.completion;
  }

  attempt.lifecycle = 'active';
  return null;
}

function applyNotification(
  state: CodexTurnState,
  message: AppServerNotificationMessage,
  emit: (event: ProviderEventBody) => void,
): void {
  if (state.finalized) {
    return;
  }
  const attempt = state.activeAttempt;
  if (message.method === 'thread/started' || message.method === 'thread/name/updated') {
    deliverNotification(state, attempt, message, emit);
    return;
  }
  const messageTurnId = extractTurnId(message);
  if (messageTurnId !== null && state.retiredControllerTurnIds.has(messageTurnId)) {
    return;
  }
  if (!attempt.startSettled || attempt.turnId === null) {
    if (admitBufferedNotification(state, message)) {
      maybeDiscoverTurnId(state, message);
      if (attempt.startSettled && attempt.turnId !== null) {
        flushBufferedNotifications(state, attempt, emit);
      }
    }
    return;
  }
  deliverNotification(state, attempt, message, emit);
}

function abortResultPromise(
  lease: ProviderServerLease,
  runtime: CodexProviderRuntime,
  state: CodexTurnState,
  attempt: TurnAttempt,
): { promise: Promise<CodexKernelResult>; cleanup(): void } {
  let cleanup = () => {};
  const promise = new Promise<void>((resolve) => {
    if (runtime.signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => resolve();
    runtime.signal.addEventListener('abort', onAbort, { once: true });
    cleanup = () => runtime.signal.removeEventListener('abort', onAbort);
  }).then(async (): Promise<CodexKernelResult> => {
    if (attempt.turnId === null) {
      const discovered = await Promise.race([
        attempt.idReady.then(() => 'id' as const),
        lease.closed.then(() => 'closed' as const),
      ]);
      if (discovered === 'closed') {
        return { kind: 'aborted', reason: 'signal_abort', attempt };
      }
    }
    return await finishAbortedStart(lease, runtime, state, attempt);
  });
  return { promise, cleanup: () => cleanup() };
}

function transportClosedResult(
  runtime: CodexProviderRuntime,
  attempt: TurnAttempt,
  closed: Error | void,
): CodexKernelResult {
  if (runtime.signal.aborted) {
    return {
      kind: 'aborted',
      reason: 'signal_abort',
      preserveRecoverySnapshot: attempt.turnId !== null,
      attempt,
    };
  }
  return {
    kind: 'failed',
    message: closed instanceof Error ? closed.message : 'Codex app-server transport closed before the turn completed.',
    preserveRecoverySnapshot: true,
    attempt,
  };
}

async function finishAbortedStart(
  lease: ProviderServerLease,
  runtime: CodexProviderRuntime,
  state: CodexTurnState,
  attempt: TurnAttempt,
): Promise<CodexKernelResult> {
  const outcome = await Promise.race([
    ensureInterrupt(lease, state, attempt).then((interrupted) => ({ kind: 'interrupt' as const, interrupted })),
    lease.closed.then(() => ({ kind: 'closed' as const })),
  ]);
  if (outcome.kind === 'closed') {
    return transportClosedResult(runtime, attempt, undefined);
  }
  return {
    kind: 'aborted',
    reason: 'signal_abort',
    preserveRecoverySnapshot: outcome.interrupted !== 'confirmed',
    attempt,
  };
}

async function waitForTurnResult(
  lease: ProviderServerLease,
  runtime: CodexProviderRuntime,
  state: CodexTurnState,
): Promise<CodexKernelResult> {
  const attempt = state.activeAttempt;
  const aborted = abortResultPromise(lease, runtime, state, attempt);
  try {
    return await Promise.race([
      attempt.completion,
      lease.closed.then((closed) => transportClosedResult(runtime, attempt, closed)),
      aborted.promise,
    ]);
  } finally {
    aborted.cleanup();
  }
}

export function createCodexTurnStateForTest(request: ProviderRequest, runtime: CodexProviderRuntime): CodexTurnState {
  return createState(request, runtime);
}

export function applyCodexNotificationForTest(
  state: CodexTurnState,
  message: AppServerNotificationMessage,
  emit: (event: ProviderEventBody) => void,
): void {
  applyNotification(state, message, emit);
}

export function buildCodexCompletedTerminalForTest(
  state: CodexTurnState,
  turn: Turn,
): Extract<ProviderEventBody, { kind: 'terminal' }> {
  return buildCompletedTerminal(state, turn);
}

export function buildCodexFailedTerminalForTest(
  state: CodexTurnState,
  message: string,
): Extract<ProviderEventBody, { kind: 'terminal' }> {
  return buildFailedTerminal(state, message);
}

export function buildCodexAbortedTerminalForTest(
  state: CodexTurnState,
): Extract<ProviderEventBody, { kind: 'terminal' }> {
  return buildAbortedTerminal(state);
}

export function finishCodexCompletedForTest(
  state: CodexTurnState,
  turn: Turn,
  emit: (event: ProviderEventBody) => void,
): Extract<ProviderEventBody, { kind: 'terminal' }> | null {
  return finishInvocation(
    state,
    { kind: 'completed', turn, source: 'notification', attempt: state.activeAttempt },
    emit,
  );
}

function isSuccessfulTurn(status: string | undefined): boolean {
  return status === undefined || status === 'completed';
}

function isAbortedTurn(status: string | undefined): boolean {
  return status === 'aborted' || status === 'cancelled' || status === 'canceled' || status === 'interrupted';
}

function buildAbortedTerminal(state: CodexTurnState): Extract<ProviderEventBody, { kind: 'terminal' }> {
  const usage = normalizeCodexUsage(state.latestTokenCount);
  return {
    kind: 'terminal',
    terminal: buildJobTerminal({
      content: '',
      model: state.model,
      durationMs: state.time.now() - state.startedAt,
      outcome: { kind: 'aborted', reason: 'signal_abort' },
      usage,
    }),
    diagnostics: buildJobDiagnostics({}),
  };
}

function buildFailedTerminal(state: CodexTurnState, message: string): Extract<ProviderEventBody, { kind: 'terminal' }> {
  const usage = normalizeCodexUsage(state.latestTokenCount);
  return {
    kind: 'terminal',
    terminal: buildJobTerminal({
      content: '',
      model: state.model,
      durationMs: state.time.now() - state.startedAt,
      outcome: {
        kind: 'provider_exit',
        code: CODEX_RPC_FAILURE_EXIT_CODE,
        note: buildProviderFailureMessage('Codex', message),
      },
      usage,
    }),
    diagnostics: buildJobDiagnostics({}),
  };
}

function buildCompletedTerminal(state: CodexTurnState, turn: Turn): Extract<ProviderEventBody, { kind: 'terminal' }> {
  const turnStatus = turn?.status;
  const turnFailed = !isSuccessfulTurn(turnStatus);
  const turnAborted = isAbortedTurn(turnStatus);
  const usage = normalizeCodexUsage(state.latestTokenCount);
  const errorMessage = state.finalErrorMessage ?? turnFailureMessage(turn, state.activeAttempt.terminalErrors);
  const failureNote = turnFailed
    ? (buildProviderFailureMessage('Codex', errorMessage, turnStatus) ?? 'Codex session driver reported a failed turn.')
    : undefined;

  return {
    kind: 'terminal',
    terminal: buildJobTerminal({
      content: state.lastAgentMessage,
      model: state.model,
      durationMs: state.time.now() - state.startedAt,
      outcome: codexTurnOutcome(turnAborted, turnFailed, failureNote),
      usage,
    }),
    diagnostics: buildJobDiagnostics({}),
  };
}

function codexTurnOutcome(turnAborted: boolean, turnFailed: boolean, failureNote: string | undefined) {
  if (turnAborted) {
    return { kind: 'aborted', reason: 'signal_abort' } as const;
  }

  if (turnFailed) {
    return { kind: 'provider_exit', code: CODEX_RPC_FAILURE_EXIT_CODE, note: failureNote ?? '' } as const;
  }

  return { kind: 'completed' } as const;
}

function finishInvocation(
  state: CodexTurnState,
  result: CodexKernelResult,
  emit: (event: ProviderEventBody) => void,
): Extract<ProviderEventBody, { kind: 'terminal' }> | null {
  if (state.finalized) {
    return null;
  }
  state.finalized = true;

  if (result.kind === 'completed') {
    state.finalErrorMessage = turnFailureMessage(result.turn, result.attempt.terminalErrors);
    if (result.source === 'notification') {
      emitCodexRolloutArtifactHandleOnce(state, emit);
    }
    if (state.threadId !== null) {
      checkpoint(state, state.threadId);
    }
    return buildCompletedTerminal(state, result.turn);
  }

  if (result.kind === 'aborted') {
    if (!result.preserveRecoverySnapshot && state.threadId !== null) {
      checkpoint(state, state.threadId);
    }
    return buildAbortedTerminal(state);
  }

  if (!result.preserveRecoverySnapshot && state.threadId !== null) {
    checkpoint(state, state.threadId);
  }
  return buildFailedTerminal(state, result.message);
}

function retireAttempt(state: CodexTurnState, attempt: TurnAttempt): void {
  clearCompletionTimer(state, attempt);
  attempt.lifecycle = 'settled';
  if (attempt.turnId !== null) {
    state.retiredControllerTurnIds.add(attempt.turnId);
  }
  attempt.bufferedNotifications.length = 0;
  if (state.threadId !== null) {
    checkpoint(state, state.threadId);
  }
}

function emitFinalTurnProgress(result: CodexKernelResult, emit: (event: ProviderEventBody) => void): void {
  if (result.kind !== 'completed') {
    return;
  }
  if (recoverableTurnFailure(result.turn, result.attempt.terminalErrors) !== null) {
    return;
  }
  emitProgress(emit, `Turn ${result.turn.status ?? 'finished'}.`);
}

export const codexTurnKernel: Provider<CodexExecutionContext> = (request, runtime) =>
  streamProviderEvents<ProviderEventBody>(async (emit) => {
    const lease = requireAppServerLease(runtime, 'codex');
    const state = createState(request, runtime);
    state.lease = lease;
    const clearNotificationBinding = bindAppServerNotificationHandler(runtime, (message) => {
      applyNotification(state, message, emit);
    });
    const clearInterruptBinding = bindCodexInterruptState(lease, state);

    try {
      await initializeThread(request, runtime, lease, state, emit);

      if (runtime.signal.aborted) {
        const terminal = finishInvocation(state, { kind: 'aborted', reason: 'signal_abort' }, emit);
        if (terminal) emit(terminal);
        return;
      }

      if (state.threadId === null) {
        throw new Error('Codex thread id missing after initialization.');
      }
      const originalParams = mapTurnStartParams(request, state.threadId, state.serviceTier);
      let params = originalParams;
      let continuationCount = 0;
      const recoveredFailures = new Set<RecoverableTurnFailure>();

      for (;;) {
        const attempt = state.activeAttempt;
        const started = await startTurn(runtime, lease, state, attempt, params, emit);
        const result = started ?? (await waitForTurnResult(lease, runtime, state));

        const recoveryReason =
          result.kind === 'completed' ? recoverableTurnFailure(result.turn, result.attempt.terminalErrors) : null;
        if (
          result.kind === 'completed' &&
          result.attempt.turnId !== null &&
          recoveryReason !== null &&
          !recoveredFailures.has(recoveryReason)
        ) {
          retireAttempt(state, attempt);
          emitProgress(
            emit,
            recoveryReason === 'serverOverloaded'
              ? 'Codex capacity reached; retrying the same thread (1/1).'
              : 'Codex policy check stopped the turn; retrying the same thread (1/1).',
          );
          if (runtime.signal.aborted) {
            const terminal = finishInvocation(state, { kind: 'aborted', reason: 'signal_abort', attempt }, emit);
            if (terminal) emit(terminal);
            return;
          }
          recoveredFailures.add(recoveryReason);
          continuationCount += 1;
          state.activeAttempt = createAttempt(continuationCount);
          params = mapRecoveryContinuationTurnStartParams(originalParams, recoveryReason);
          continue;
        }

        emitFinalTurnProgress(result, emit);
        const terminal = finishInvocation(state, result, emit);
        if (terminal) emit(terminal);
        return;
      }
    } catch (error) {
      if (isCodexSessionUnavailable(error)) {
        throw error;
      }

      if (runtime.signal.aborted) {
        const terminal = finishInvocation(
          state,
          { kind: 'aborted', reason: 'signal_abort', attempt: state.activeAttempt },
          emit,
        );
        if (terminal) emit(terminal);
        return;
      }

      const terminal = finishInvocation(
        state,
        { kind: 'failed', message: errorMessage(error), attempt: state.activeAttempt },
        emit,
      );
      if (terminal) emit(terminal);
    } finally {
      clearCompletionTimer(state, state.activeAttempt);
      clearInterruptBinding();
      clearNotificationBinding();
    }
  });
