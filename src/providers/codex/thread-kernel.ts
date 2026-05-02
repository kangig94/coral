import { errorMessage } from '../../infra/error-format.js';
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

const INFERRED_COMPLETION_DELAY_MS = 250;
export const PRE_TURN_MAILBOX_CAP = 64;

// Sentinel exit code surfaced when the Codex app-server reports a turn failure
// over RPC instead of the wrapper observing a process exit. Codex thread-kernel
// drives a long-running app-server lease, so no real OS exit code is available;
// the diagnostic message goes into `note`. See spec §7.1 `provider_exit`.
const CODEX_RPC_FAILURE_EXIT_CODE = 1;

export type PreTurnMailboxStatus = {
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
  if (persistedContinuity.threadId) {
    mailboxThreadCandidates.add(persistedContinuity.threadId);
  }
  if (request.conversationRef) {
    mailboxThreadCandidates.add(request.conversationRef);
  }

  const state = {
    startedAt: runtime.time.now(),
    cwd: persistedContinuity.cwd ?? request.cwd,
    model: resolveModelTier(request.model),
    serviceTier: resolveCodexServiceTier(request, runtime),
    sessionId: request.sessionId,
    persistedThreadId: persistedContinuity.threadId ?? null,
    mailboxThreadCandidates,
    threadId: null,
    threadIds: new Set(),
    threadTurnIds: new Map(),
    turnId: null,
    turnStartRequested: false,
    checkpointedTurnId: null,
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
  if (!request.conversationRef) {
    throw new Error('resume requires conversationRef');
  }
  return request.conversationRef;
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

function extractThreadId(message: AppServerNotificationMessage): string | null {
  return (message as { params?: { threadId?: string } }).params?.threadId ?? null;
}

function extractTurnId(message: AppServerNotificationMessage): string | null {
  const params = (message as { params?: { turnId?: string; turn?: { id?: string } } }).params;
  if (params?.turnId) {
    return params.turnId;
  }
  if (params?.turn?.id) {
    return params.turn.id;
  }
  return null;
}

function registerThread(state: CodexTurnState, threadId: string | null): void {
  if (!threadId) {
    return;
  }
  state.threadIds.add(threadId);
}

function registerMailboxThreadCandidate(state: CodexTurnState, threadId: string | null): void {
  if (!threadId) {
    return;
  }
  state.mailboxThreadCandidates.add(threadId);
}

function canAdmitNotification(state: CodexTurnState, message: AppServerNotificationMessage): boolean {
  const threadId = extractThreadId(message);
  if (!threadId) {
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
    state.finalTurn = turn;
    state.turnId ??= turn.id;
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
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
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
        if (typeof receiverThreadId === 'string') {
          registerThread(state, receiverThreadId);
        }
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
  const params = notification.params as { item?: Record<string, unknown>; threadId?: string } | undefined;
  if (!params?.item) {
    return;
  }

  recordItem(state, params.item, lifecycle, params.threadId ?? null);
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
      const thread = notification.params?.thread as { id?: string } | undefined;
      registerThread(state, thread?.id ?? null);
      return;
    }
    case 'thread/name/updated':
      registerThread(state, extractThreadId(message));
      return;
    case 'turn/started': {
      const threadId = extractThreadId(message);
      const turnId = extractTurnId(message);
      registerThread(state, threadId);
      if (threadId && turnId) {
        state.threadTurnIds.set(threadId, turnId);
      }
      if (threadId === state.threadId && turnId && !state.turnId) {
        state.turnId = turnId;
      }
      if (threadId && threadId !== state.threadId) {
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
    case 'error': {
      const params = notification.params as { error?: { message?: string } } | undefined;
      state.error = params?.error ?? { message: 'Codex app-server turn failed.' };
      emitProgress(emit, `Codex error: ${state.error.message ?? 'unknown error'}`);
      return;
    }
    case 'turn/completed': {
      const threadId = extractThreadId(message);
      const turn = (notification.params as { turn?: Turn } | undefined)?.turn ?? null;
      if (threadId && threadId !== state.threadId) {
        state.activeSubagentTurns.delete(threadId);
        scheduleInferredCompletion(state);
        return;
      }
      emitProgress(emit, `Turn ${turn?.status === 'completed' ? 'completed' : (turn?.status ?? 'finished')}.`);
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
  if (!threadId || !turnId || !state.threadId || threadId !== state.threadId) {
    return;
  }
  state.turnId = turnId;
  state.threadTurnIds.set(threadId, turnId);
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
  if (!state.turnId || state.bufferedNotifications.length === 0) {
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
  if (!state?.threadId || !state.turnId) {
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
      threadId = response.thread.id;
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
    threadId = response.thread.id;
  }

  state.threadId = threadId;
  registerMailboxThreadCandidate(state, threadId);
  registerThread(state, threadId);
  checkpoint(runtime, state, threadId);
  emitProgress(emit, `Thread ready (${threadId}).`);
}

async function startTurn(
  request: ProviderRequest,
  runtime: ProviderRuntime,
  lease: ProviderServerLease,
  state: CodexTurnState,
  emit: (event: ProviderEventBody) => void,
): Promise<CodexKernelResult | null> {
  state.turnStartRequested = true;
  if (runtime.signal.aborted && !state.turnId) {
    return { kind: 'aborted', reason: 'signal_abort' };
  }
  if (!state.threadId) {
    throw new Error('Codex thread id missing before turn/start.');
  }

  const response = await rpc(lease, 'turn/start', mapTurnStartParams(request, state.threadId, state.serviceTier));
  state.turnId = response.turn?.id ?? null;
  if (state.turnId) {
    state.threadTurnIds.set(state.threadId, state.turnId);
    state.checkpointedTurnId = state.turnId;
    checkpoint(runtime, state, state.threadId, state.turnId);
  }

  flushBufferedNotifications(state, emit);

  if (!state.turnId && runtime.signal.aborted) {
    return { kind: 'aborted', reason: 'signal_abort' };
  }

  if (response.turn?.status && response.turn.status !== 'inProgress') {
    state.finalTurn = response.turn;
    return {
      kind: 'completed',
      turn: response.turn,
    };
  }

  return null;
}

function applyNotification(
  state: CodexTurnState,
  message: AppServerNotificationMessage,
  emit: (event: ProviderEventBody) => void,
): void {
  if (!state.turnId) {
    if (admitBufferedNotification(state, message)) {
      maybeDiscoverTurnId(state, message);
      if (state.turnStartRequested && state.turnId) {
        flushBufferedNotifications(state, emit);
      }
    }
    return;
  }
  deliverNotification(state, message, emit);
}

async function awaitKernelResult(runtime: ProviderRuntime, state: CodexTurnState): Promise<CodexKernelResult> {
  await state.completion;
  if (state.threadId && state.turnId && state.turnId !== state.checkpointedTurnId) {
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

function isSuccessfulTurn(status: string | undefined): boolean {
  return status === undefined || status === 'completed';
}

function isAbortedTurn(status: string | undefined): boolean {
  return status === 'aborted' || status === 'cancelled' || status === 'canceled' || status === 'interrupted';
}

function buildAbortedTerminal(state: CodexTurnState): Extract<ProviderEventBody, { kind: 'terminal' }> {
  return {
    kind: 'terminal',
    terminal: buildJobTerminal({
      content: '',
      model: state.model,
      durationMs: state.time.now() - state.startedAt,
      outcome: { kind: 'aborted', reason: 'signal_abort' },
    }),
    diagnostics: buildJobDiagnostics({}),
  };
}

function buildFailedTerminal(state: CodexTurnState, message: string): Extract<ProviderEventBody, { kind: 'terminal' }> {
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
    }),
    diagnostics: buildJobDiagnostics({}),
  };
}

function buildCompletedTerminal(state: CodexTurnState, turn: Turn): Extract<ProviderEventBody, { kind: 'terminal' }> {
  const turnStatus = turn?.status;
  const turnFailed = !isSuccessfulTurn(turnStatus);
  const turnAborted = isAbortedTurn(turnStatus);
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
      outcome: turnAborted
        ? { kind: 'aborted', reason: 'signal_abort' }
        : turnFailed
          ? { kind: 'provider_exit', code: CODEX_RPC_FAILURE_EXIT_CODE, note: failureNote ?? '' }
          : { kind: 'completed' },
    }),
    diagnostics: buildJobDiagnostics({}),
  };
}

function finalizeTerminal(
  runtime: ProviderRuntime,
  state: CodexTurnState,
  result: CodexKernelResult,
): Extract<ProviderEventBody, { kind: 'terminal' }> {
  if (result.kind === 'completed') {
    if (state.threadId) {
      checkpoint(runtime, state, state.threadId);
    }
    return buildCompletedTerminal(state, result.turn);
  }

  if (result.kind === 'aborted') {
    if (state.threadId) {
      checkpoint(runtime, state, state.threadId);
    }
    return buildAbortedTerminal(state);
  }

  if (!result.preserveRecoverySnapshot && state.threadId) {
    checkpoint(runtime, state, state.threadId);
  }
  return buildFailedTerminal(state, result.message);
}

export const codexTurnKernel: Provider = (request, runtime) =>
  streamProviderEvents<ProviderEventBody>(async (emit) => {
    if (request.action === 'fork') {
      throw new Error('Codex app-server fork is unsupported until clone/fork RPC is available.');
    }

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
