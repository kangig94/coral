import type { ProviderContinuityBlob, ProviderTurnResult } from '../../shared/types.js';
import { readString } from '../../shared/utils.js';
import { resolveModelTier } from '../../shared/schemas.js';
import {
  buildProviderFailureMessage,
  type AppServerSessionDriver,
  type DriverContext,
  type DriverStepOutcome,
} from '../app-server/driver.js';
import { requireConversationRef } from '../types.js';
import {
  buildCodexProviderServerSpec,
  mapThreadResumeParams,
  mapThreadStartParams,
  mapTurnStartParams,
  resolveCodexServiceTier,
  type CodexServiceTier,
} from './request-mapping.js';
import type {
  AppServerMethod,
  AppServerNotification,
  AppServerRequestParams,
  AppServerResponse,
  Turn,
} from './protocol.js';

const INFERRED_COMPLETION_DELAY_MS = 250;

type CodexContinuity = {
  cwd?: string;
  threadId?: string;
  turnId?: string;
};

export type CodexTurnState = {
  ctx: DriverContext;
  startedAt: number;
  cwd: string;
  model: string | undefined;
  serviceTier: CodexServiceTier | undefined;
  sessionId: string;
  threadId: string | null;
  threadIds: Set<string>;
  threadTurnIds: Map<string, string>;
  turnId: string | null;
  turnStartRequested: boolean;
  checkpointedTurnId: string | null;
  bufferedNotifications: AppServerNotification[];
  completion: Promise<void>;
  resolveCompletion: () => void;
  rejectCompletion: (error: unknown) => void;
  finalTurn: Turn | null;
  completed: boolean;
  finalAnswerSeen: boolean;
  pendingCollaborations: Set<string>;
  activeSubagentTurns: Set<string>;
  completionTimer: ReturnType<typeof setTimeout> | null;
  lastAgentMessage: string;
  error: { message?: string } | null;
  interruptRequest: Promise<void> | null;
};

function extractThreadId(message: AppServerNotification): string | null {
  return (message as { params?: { threadId?: string } }).params?.threadId ?? null;
}

function extractTurnId(message: AppServerNotification): string | null {
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

function clearCompletionTimer(state: CodexTurnState): void {
  if (!state.completionTimer) {
    return;
  }
  clearTimeout(state.completionTimer);
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
  state.completionTimer = setTimeout(() => {
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

function belongsToTurn(state: CodexTurnState, message: AppServerNotification): boolean {
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

function emitProgress(state: CodexTurnState, message: string | null | undefined): void {
  if (!message) {
    return;
  }
  state.ctx.emitProgress(message);
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
): void {
  const params = notification.params as { item?: Record<string, unknown>; threadId?: string } | undefined;
  if (!params?.item) {
    return;
  }

  recordItem(state, params.item, lifecycle, params.threadId ?? null);
  emitProgress(state, describe(params.item));
}

function applyNotificationCore(state: CodexTurnState, message: AppServerNotification): void {
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
      emitProgress(state, `Turn started (${turnId ?? 'unknown'}).`);
      return;
    }
    case 'item/started':
      handleItemNotification(state, notification, 'started', describeStartedItem);
      return;
    case 'item/completed':
      handleItemNotification(state, notification, 'completed', describeCompletedItem);
      return;
    case 'error': {
      const params = notification.params as { error?: { message?: string } } | undefined;
      state.error = params?.error ?? { message: 'Codex app-server turn failed.' };
      emitProgress(state, `Codex error: ${state.error.message ?? 'unknown error'}`);
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
      emitProgress(state, `Turn ${turn?.status === 'completed' ? 'completed' : (turn?.status ?? 'finished')}.`);
      completeTurn(state, turn);
      return;
    }
    default:
      return;
  }
}

function maybeDiscoverTurnId(state: CodexTurnState, message: AppServerNotification): void {
  const threadId = extractThreadId(message);
  const turnId = extractTurnId(message);
  if (!threadId || !turnId || !state.threadId || threadId !== state.threadId) {
    return;
  }
  state.turnId = turnId;
  state.threadTurnIds.set(threadId, turnId);
}

function deliverNotification(state: CodexTurnState, message: AppServerNotification): void {
  if (message.method === 'thread/started' || message.method === 'thread/name/updated') {
    applyNotificationCore(state, message);
    return;
  }
  if (!belongsToTurn(state, message)) {
    return;
  }
  applyNotificationCore(state, message);
}

function flushBufferedNotifications(state: CodexTurnState): void {
  if (!state.turnId || state.bufferedNotifications.length === 0) {
    return;
  }
  const buffered = state.bufferedNotifications.splice(0, state.bufferedNotifications.length);
  for (const message of buffered) {
    deliverNotification(state, message);
  }
}

function isMissingConversationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('not found') ||
    message.includes('missing thread') ||
    message.includes('unknown thread') ||
    message.includes('does not exist') ||
    message.includes('no such thread')
  );
}

function isSuccessfulTurn(status: string | undefined): boolean {
  return status === undefined || status === 'completed';
}

function isAbortedTurn(status: string | undefined): boolean {
  return status === 'aborted' || status === 'cancelled' || status === 'canceled' || status === 'interrupted';
}

function toCodexContinuity(continuity: ProviderContinuityBlob | undefined): CodexContinuity {
  return {
    cwd: readString(continuity?.cwd),
    threadId: readString(continuity?.threadId),
    turnId: readString(continuity?.turnId),
  };
}

function buildCodexContinuity(cwd: string, threadId: string, turnId?: string | null): ProviderContinuityBlob {
  return turnId ? { cwd, threadId, turnId } : { cwd, threadId };
}

function checkpoint(state: CodexTurnState, threadId: string, turnId?: string | null): void {
  state.ctx.checkpointRecovery({
    conversationRef: threadId,
    providerMeta: {
      providerContinuity: buildCodexContinuity(state.cwd, threadId, turnId),
    },
  });
}

async function rpc<M extends AppServerMethod>(
  ctx: DriverContext,
  method: M,
  params: AppServerRequestParams<M>,
): Promise<AppServerResponse<M>> {
  return ctx.lease.rpc<AppServerResponse<M>>(method, params as unknown as Record<string, unknown>);
}

async function interruptTurn(ctx: DriverContext, threadId: string, turnId: string): Promise<void> {
  await rpc(ctx, 'turn/interrupt', { threadId, turnId });
}

export const codexSessionDriver: AppServerSessionDriver<CodexTurnState> = {
  name: 'Codex',
  faultProviderName: 'codex',
  subscriptionPhase: 'afterInitialize',

  buildServerSpec(request, persistedContinuity) {
    const { cwd } = toCodexContinuity(persistedContinuity);
    return buildCodexProviderServerSpec(cwd ?? request.cwd, request.coralEnv);
  },

  createInitialState(ctx, request) {
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    return {
      ctx,
      startedAt: Date.now(),
      cwd: request.cwd,
      model: resolveModelTier(request.model),
      serviceTier: resolveCodexServiceTier(request, ctx.runtime),
      sessionId: request.sessionId,
      threadId: null,
      threadIds: new Set(),
      threadTurnIds: new Map(),
      turnId: null,
      turnStartRequested: false,
      checkpointedTurnId: null,
      bufferedNotifications: [],
      completion,
      resolveCompletion,
      rejectCompletion,
      finalTurn: null,
      completed: false,
      finalAnswerSeen: false,
      pendingCollaborations: new Set(),
      activeSubagentTurns: new Set(),
      completionTimer: null,
      lastAgentMessage: '',
      error: null,
      interruptRequest: null,
    };
  },

  async initialize(ctx, state, request): Promise<DriverStepOutcome> {
    let threadId: string;

    if (request.action === 'resume') {
      const conversationRef = requireConversationRef(request, 'resume');
      try {
        const response = await rpc(ctx, 'thread/resume', mapThreadResumeParams(request, conversationRef, state.serviceTier));
        threadId = response.thread.id;
      } catch (error) {
        if (isMissingConversationError(error)) {
          state.error = { message: error instanceof Error ? error.message : String(error) };
          return {
            terminal: {
              kind: 'nonResumable',
              message: `Conversation ${conversationRef} is no longer resumable because the saved thread is missing or invalid.`,
            },
          };
        }
        throw error;
      }
    } else {
      const response = await rpc(ctx, 'thread/start', mapThreadStartParams(request, state.serviceTier));
      threadId = response.thread.id;
    }

    state.threadId = threadId;
    registerThread(state, threadId);
    checkpoint(state, threadId);
    emitProgress(state, `Thread ready (${threadId}).`);
    return {};
  },

  async startTurn(ctx, state, request): Promise<DriverStepOutcome> {
    state.turnStartRequested = true;
    if (ctx.runtime.signal.aborted && !state.turnId) {
      return { terminal: { kind: 'aborted', reason: 'signal_abort' } };
    }
    if (!state.threadId) {
      throw new Error('Codex thread id missing before turn/start.');
    }

    const response = await rpc(ctx, 'turn/start', mapTurnStartParams(request, state.threadId, state.serviceTier));
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
      state.checkpointedTurnId = state.turnId;
      checkpoint(state, state.threadId, state.turnId);
    }

    flushBufferedNotifications(state);

    if (!state.turnId && ctx.runtime.signal.aborted) {
      return { terminal: { kind: 'aborted', reason: 'signal_abort' } };
    }

    if (response.turn?.status && response.turn.status !== 'inProgress') {
      state.finalTurn = response.turn;
      return {
        terminal: {
          kind: 'completed',
          turn: response.turn,
        },
      };
    }

    return {};
  },

  applyNotification(state, message) {
    if (!state.turnId) {
      state.bufferedNotifications.push(message);
      maybeDiscoverTurnId(state, message);
      if (state.turnStartRequested && state.turnId) {
        flushBufferedNotifications(state);
      }
      return;
    }
    deliverNotification(state, message);
  },

  async awaitTurnOutcome(state) {
    await state.completion;
    if (state.threadId && state.turnId && state.turnId !== state.checkpointedTurnId) {
      checkpoint(state, state.threadId, state.turnId);
      state.checkpointedTurnId = state.turnId;
    }
    return {
      kind: 'completed',
      turn: state.finalTurn ?? {
        id: state.turnId ?? 'inferred-turn',
        status: state.error?.message ? 'failed' : 'completed',
      },
    } as const;
  },

  async requestInterrupt(ctx, state) {
    if (!state.threadId || !state.turnId) {
      return;
    }
    state.interruptRequest ??= interruptTurn(ctx, state.threadId, state.turnId).catch(() => {});
    await state.interruptRequest;
  },

  onTransportClosed(_state, outcome) {
    return {
      kind: 'failed',
      message:
        outcome instanceof Error
          ? outcome.message
          : 'Codex app-server transport closed before the turn completed.',
    };
  },

  finalize(state, outcome): ProviderTurnResult {
    if (outcome.kind === 'nonResumable') {
      return {
        content: '',
        durationMs: Date.now() - state.startedAt,
        nonResumable: true,
        outcome: {
          kind: 'legacy_fault',
          fault: {
            kind: 'provider_session_unavailable',
            provider: 'codex',
            note: outcome.message,
          },
        },
      };
    }

    if (state.threadId) {
      checkpoint(state, state.threadId);
    }

    if (outcome.kind === 'aborted') {
      return {
        content: '',
        conversationRef: state.threadId ?? undefined,
        model: state.model,
        durationMs: Date.now() - state.startedAt,
        outcome: { kind: 'aborted', reason: outcome.reason },
      };
    }

    if (outcome.kind === 'failed') {
      return {
        content: '',
        conversationRef: state.threadId ?? undefined,
        model: state.model,
        durationMs: Date.now() - state.startedAt,
        outcome: {
          kind: 'legacy_fault',
          fault: {
            kind: 'provider_request_failed',
            provider: 'codex',
            message: buildProviderFailureMessage('Codex', outcome.message),
          },
        },
      };
    }

    const turn = outcome.turn as Turn;
    const turnStatus = turn?.status;
    const turnFailed = !isSuccessfulTurn(turnStatus);
    const turnAborted = isAbortedTurn(turnStatus);
    const failureMessage = turnFailed
      ? buildProviderFailureMessage('Codex', state.error?.message, turnStatus)
      : undefined;

    return {
      content: state.lastAgentMessage,
      conversationRef: state.threadId ?? undefined,
      model: state.model,
      durationMs: Date.now() - state.startedAt,
      outcome: turnAborted
        ? { kind: 'aborted', reason: 'signal_abort' }
        : turnFailed
          ? {
              kind: 'legacy_fault',
              fault: {
                kind: 'provider_request_failed',
                provider: 'codex',
                message: failureMessage ?? 'Codex session driver reported a failed turn.',
              },
            }
          : { kind: 'completed' },
    };
  },
};
