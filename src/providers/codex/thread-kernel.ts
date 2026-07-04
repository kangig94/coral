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
  mapThreadResumeParams,
  mapThreadStartParams,
  mapTurnStartParams,
  readCodexPersistedContinuity,
  resolveCodexServiceTier,
  type CodexServiceTier,
} from './request-mapping.js';
import type { AppServerMethod, AppServerRequestParams, AppServerResponse, Turn } from './protocol.js';
import { locateCodexRolloutArtifactFromRuntime } from './artifacts.js';

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
  threadTurnIds: Map<string, string>;
  turnId: string | null;
  turnStartRequested: boolean;
  checkpointedTurnId: string | null;
  artifactHandleEmissionAttempted: boolean;
  artifactLocatorRuntime: Pick<ProviderRuntime, 'env' | 'storage'>;
  bufferedNotifications: AppServerNotificationMessage[];
  bufferedNotificationsDropped: number;
  preTurnMailbox: {
    status(): PreTurnMailboxStatus;
  };
  completion: Promise<void>;
  resolveCompletion: () => void;
  finalTurn: Turn | null;
  completed: boolean;
  finalAnswerSeen: boolean;
  pendingCollaborations: Set<string>;
  activeSubagentTurns: Set<string>;
  completionTimer: ReturnType<TimePort['setTimeout']> | null;
  lastAgentMessage: string;
  latestTokenCount: CodexTokenUsage | null;
  error: { message?: string } | null;
  interruptRequest: Promise<void> | null;
  time: Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout'>;
};

type CodexKernelResult =
  | { kind: 'completed'; turn: Turn }
  | { kind: 'failed'; message: string; preserveRecoverySnapshot?: boolean }
  | { kind: 'aborted'; reason: 'signal_abort' };

const codexInterruptBindings = new WeakMap<ProviderServerLease, CodexTurnState>();

function bindCodexInterruptState(lease: ProviderServerLease, state: CodexTurnState): () => void {
  codexInterruptBindings.set(lease, state);
  return () => {
    if (codexInterruptBindings.get(lease) === state) {
      codexInterruptBindings.delete(lease);
    }
  };
}

function createState(request: ProviderRequest, runtime: ProviderRuntime): CodexTurnState {
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
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
    threadTurnIds: new Map(),
    turnId: null,
    turnStartRequested: false,
    checkpointedTurnId: null,
    artifactHandleEmissionAttempted: false,
    artifactLocatorRuntime: {
      env: runtime.env,
      storage: runtime.storage,
    },
    bufferedNotifications: [],
    bufferedNotificationsDropped: 0,
    preTurnMailbox: {
      status: () => ({
        pending: 0,
        dropped: 0,
      }),
    },
    completion,
    resolveCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    lastAgentMessage: '',
    latestTokenCount: null,
    error: null,
    interruptRequest: null,
    time: runtime.time,
  } satisfies CodexTurnState;

  state.preTurnMailbox = {
    status: () => ({
      pending: state.bufferedNotifications.length,
      dropped: state.bufferedNotificationsDropped,
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
  if (state.bufferedNotifications.length >= PRE_TURN_MAILBOX_CAP) {
    state.bufferedNotifications.shift();
    state.bufferedNotificationsDropped += 1;
  }
  state.bufferedNotifications.push(message);
  return true;
}

function clearCompletionTimer(state: CodexTurnState): void {
  if (!state.completionTimer) {
    return;
  }
  state.time.clearTimeout(state.completionTimer);
  state.completionTimer = null;
}

function completeTurn(state: CodexTurnState, turn: Turn | null = null): void {
  if (state.completed) {
    return;
  }
  clearCompletionTimer(state);
  state.completed = true;
  if (turn) {
    const turnId = readTurnId(turn);
    state.finalTurn = canonicalTurn(turn, state.turnId);
    if (turnId !== null && state.turnId === null) {
      state.turnId = turnId;
    }
  } else {
    state.finalTurn ??= {
      id: state.turnId ?? 'inferred-turn',
      status: 'completed',
    };
  }
  state.resolveCompletion();
}

function scheduleInferredCompletion(state: CodexTurnState): void {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }
  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }

  clearCompletionTimer(state);
  state.completionTimer = state.time.setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    completeTurn(state);
  }, INFERRED_COMPLETION_DELAY_MS);
  state.completionTimer.unref?.();
}

function belongsToTurn(state: CodexTurnState, message: AppServerNotificationMessage): boolean {
  const messageThreadId = extractThreadId(message);
  if (messageThreadId === null || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || trackedTurnId === messageTurnId;
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
  item: Record<string, unknown>,
  lifecycle: 'started' | 'completed',
  threadId: string | null,
): void {
  if (item.type === 'collabAgentToolCall') {
    const itemId = typeof item.id === 'string' ? item.id : null;
    if (threadId === state.threadId && itemId) {
      if (lifecycle === 'started' || item.status === 'inProgress') {
        state.pendingCollaborations.add(itemId);
      } else if (lifecycle === 'completed') {
        state.pendingCollaborations.delete(itemId);
        scheduleInferredCompletion(state);
      }
    }
    if (Array.isArray(item.receiverThreadIds)) {
      for (const receiverThreadId of item.receiverThreadIds) {
        registerThread(state, readString(receiverThreadId) ?? null);
      }
    }
    return;
  }

  if (item.type === 'agentMessage') {
    if (threadId === null || threadId === state.threadId) {
      if (typeof item.text === 'string') {
        state.lastAgentMessage = item.text;
      }
      if (lifecycle === 'completed' && item.phase === 'final_answer') {
        state.finalAnswerSeen = true;
        scheduleInferredCompletion(state);
      }
    }
  }
}

function handleItemNotification(
  state: CodexTurnState,
  notification: { params?: Record<string, unknown> },
  lifecycle: 'started' | 'completed',
  describe: (item: Record<string, unknown>) => string | null,
  emit: (event: ProviderEventBody) => void,
): void {
  const params = notification.params as { item?: Record<string, unknown>; threadId?: unknown } | undefined;
  if (!params?.item) {
    return;
  }

  recordItem(state, params.item, lifecycle, readString(params.threadId) ?? null);
  emitProgress(emit, describe(params.item));
}

function applyNotificationCore(
  state: CodexTurnState,
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
      if (threadId !== null && turnId !== null) {
        state.threadTurnIds.set(threadId, turnId);
      }
      if (threadId === state.threadId && turnId !== null && state.turnId === null) {
        state.turnId = turnId;
      }
      if (threadId !== null && threadId !== state.threadId) {
        state.activeSubagentTurns.add(threadId);
      }
      emitProgress(emit, `Turn started (${turnId ?? 'unknown'}).`);
      return;
    }
    case 'item/started':
      handleItemNotification(state, notification, 'started', describeStartedItem, emit);
      return;
    case 'item/completed':
      handleItemNotification(state, notification, 'completed', describeCompletedItem, emit);
      return;
    case 'thread/tokenUsage/updated': {
      const total = readThreadTokenUsageTotal(message);
      if (total !== null) {
        state.latestTokenCount = total;
      }
      return;
    }
    case 'error': {
      const params = notification.params as { error?: { message?: string } } | undefined;
      state.error = params?.error ?? { message: 'Codex app-server turn failed.' };
      emitProgress(emit, `Codex error: ${state.error.message ?? 'unknown error'}`);
      return;
    }
    case 'turn/completed': {
      const threadId = extractThreadId(message);
      const turn = (notification.params as { turn?: Turn } | undefined)?.turn ?? null;
      if (threadId !== null && threadId !== state.threadId) {
        state.activeSubagentTurns.delete(threadId);
        scheduleInferredCompletion(state);
        return;
      }
      emitProgress(emit, `Turn ${turn?.status ?? 'finished'}.`);
      emitCodexRolloutArtifactHandleOnce(state, emit);
      completeTurn(state, turn);
      return;
    }
    default:
      return;
  }
}

function maybeDiscoverTurnId(state: CodexTurnState, message: AppServerNotificationMessage): void {
  const threadId = extractThreadId(message);
  const turnId = extractTurnId(message);
  if (threadId === null || turnId === null || state.threadId === null || threadId !== state.threadId) {
    return;
  }
  state.turnId = turnId;
  state.threadTurnIds.set(threadId, turnId);
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
  message: AppServerNotificationMessage,
  emit: (event: ProviderEventBody) => void,
): void {
  if (message.method === 'thread/started' || message.method === 'thread/name/updated') {
    applyNotificationCore(state, message, emit);
    return;
  }
  if (!belongsToTurn(state, message)) {
    return;
  }
  applyNotificationCore(state, message, emit);
}

function flushBufferedNotifications(state: CodexTurnState, emit: (event: ProviderEventBody) => void): void {
  if (state.turnId === null || state.bufferedNotifications.length === 0) {
    return;
  }
  const buffered = state.bufferedNotifications.splice(0, state.bufferedNotifications.length);
  for (const message of buffered) {
    deliverNotification(state, message, emit);
  }
}

function checkpoint(runtime: ProviderRuntime, state: CodexTurnState, threadId: string, turnId?: string): void {
  runtime.continuityBridge.checkpoint({
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
  if (!state || state.threadId === null || state.turnId === null) {
    return;
  }

  state.interruptRequest ??= interruptTurn(lease, state.threadId, state.turnId).catch(() => {});
  await state.interruptRequest;
}

async function initializeThread(
  request: ProviderRequest,
  runtime: ProviderRuntime,
  lease: ProviderServerLease,
  state: CodexTurnState,
  emit: (event: ProviderEventBody) => void,
): Promise<void> {
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
  checkpoint(runtime, state, threadId);
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
  request: ProviderRequest,
  runtime: ProviderRuntime,
  lease: ProviderServerLease,
  state: CodexTurnState,
  emit: (event: ProviderEventBody) => void,
): Promise<CodexKernelResult | null> {
  state.turnStartRequested = true;
  if (runtime.signal.aborted && state.turnId === null) {
    return { kind: 'aborted', reason: 'signal_abort' };
  }
  if (state.threadId === null) {
    throw new Error('Codex thread id missing before turn/start.');
  }

  const response = await rpc(lease, 'turn/start', mapTurnStartParams(request, state.threadId, state.serviceTier));
  state.turnId = readTurnId(response.turn);
  if (state.turnId !== null) {
    state.threadTurnIds.set(state.threadId, state.turnId);
    state.checkpointedTurnId = state.turnId;
    checkpoint(runtime, state, state.threadId, state.turnId);
  }

  flushBufferedNotifications(state, emit);

  if (state.turnId === null && runtime.signal.aborted) {
    return { kind: 'aborted', reason: 'signal_abort' };
  }

  if (response.turn?.status && response.turn.status !== 'inProgress') {
    const turn = canonicalTurn(response.turn, state.turnId);
    state.finalTurn = turn;
    return {
      kind: 'completed',
      turn,
    };
  }

  return null;
}

function applyNotification(
  state: CodexTurnState,
  message: AppServerNotificationMessage,
  emit: (event: ProviderEventBody) => void,
): void {
  if (state.turnId === null) {
    if (admitBufferedNotification(state, message)) {
      maybeDiscoverTurnId(state, message);
      if (state.turnStartRequested && state.turnId !== null) {
        flushBufferedNotifications(state, emit);
      }
    }
    return;
  }
  deliverNotification(state, message, emit);
}

async function awaitKernelResult(runtime: ProviderRuntime, state: CodexTurnState): Promise<CodexKernelResult> {
  await state.completion;
  if (state.threadId !== null && state.turnId !== null && state.turnId !== state.checkpointedTurnId) {
    checkpoint(runtime, state, state.threadId, state.turnId);
    state.checkpointedTurnId = state.turnId;
  }

  return {
    kind: 'completed',
    turn: state.finalTurn ?? {
      id: state.turnId ?? 'inferred-turn',
      status: state.error?.message ? 'failed' : 'completed',
    },
  };
}

async function waitForTurnResult(
  lease: ProviderServerLease,
  runtime: ProviderRuntime,
  state: CodexTurnState,
): Promise<CodexKernelResult> {
  const outcome = await Promise.race([
    awaitKernelResult(runtime, state),
    lease.closed.then((closed) => ({
      kind: 'failed' as const,
      message:
        closed instanceof Error ? closed.message : 'Codex app-server transport closed before the turn completed.',
      preserveRecoverySnapshot: true,
    })),
  ]);

  return outcome;
}

export function createCodexTurnStateForTest(request: ProviderRequest, runtime: ProviderRuntime): CodexTurnState {
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
  const failureNote = turnFailed
    ? (buildProviderFailureMessage('Codex', state.error?.message, turnStatus) ??
      'Codex session driver reported a failed turn.')
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

function finalizeTerminal(
  runtime: ProviderRuntime,
  state: CodexTurnState,
  result: CodexKernelResult,
): Extract<ProviderEventBody, { kind: 'terminal' }> {
  if (result.kind === 'completed') {
    if (state.threadId !== null) {
      checkpoint(runtime, state, state.threadId);
    }
    return buildCompletedTerminal(state, result.turn);
  }

  if (result.kind === 'aborted') {
    if (state.threadId !== null) {
      checkpoint(runtime, state, state.threadId);
    }
    return buildAbortedTerminal(state);
  }

  if (!result.preserveRecoverySnapshot && state.threadId !== null) {
    checkpoint(runtime, state, state.threadId);
  }
  return buildFailedTerminal(state, result.message);
}

export const codexTurnKernel: Provider = (request, runtime) =>
  streamProviderEvents<ProviderEventBody>(async (emit) => {
    const lease = requireAppServerLease(runtime, 'codex');
    const state = createState(request, runtime);
    const clearNotificationBinding = bindAppServerNotificationHandler(runtime, (message) => {
      applyNotification(state, message, emit);
    });
    const clearInterruptBinding = bindCodexInterruptState(lease, state);

    try {
      await initializeThread(request, runtime, lease, state, emit);

      if (runtime.signal.aborted) {
        emit(buildAbortedTerminal(state));
        return;
      }

      const started = await startTurn(request, runtime, lease, state, emit);
      if (started) {
        emit(finalizeTerminal(runtime, state, started));
        return;
      }

      if (runtime.signal.aborted) {
        await mapCodexInterrupt(lease).catch(() => {});
      }

      const result = await waitForTurnResult(lease, runtime, state);
      emit(finalizeTerminal(runtime, state, result));
    } catch (error) {
      if (isCodexSessionUnavailable(error)) {
        throw error;
      }

      if (runtime.signal.aborted) {
        emit(buildAbortedTerminal(state));
        return;
      }

      emit(buildFailedTerminal(state, errorMessage(error)));
    } finally {
      clearCompletionTimer(state);
      clearInterruptBinding();
      clearNotificationBinding();
    }
  });
