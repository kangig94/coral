import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderContinuityBlob, ProviderRequest, ProviderResult } from '../../shared/types.js';
import { errorMessage, nowIsoString, readString } from '../../shared/utils.js';
import {
  requireAppServerRuntime,
  requireConversationRef,
  type ProviderAppServerContract,
  type ProviderRuntime,
  type ProviderServerLease,
  type Provider,
} from '../types.js';
import {
  buildCodexProviderServerSpec,
  mapThreadResumeParams,
  mapThreadStartParams,
  mapTurnStartParams,
} from './request-mapping.js';
import { resolveModelTier } from '../../shared/schemas.js';
import type {
  AppServerMethod,
  AppServerNotification,
  AppServerRequestParams,
  AppServerResponse,
  Turn,
} from './protocol.js';

type CaptureState = {
  threadId: string;
  threadIds: Set<string>;
  threadTurnIds: Map<string, string>;
  turnId: string | null;
  bufferedNotifications: AppServerNotification[];
  completion: Promise<CaptureState>;
  resolveCompletion: (state: CaptureState) => void;
  rejectCompletion: (error: unknown) => void;
  finalTurn: Turn | null;
  completed: boolean;
  finalAnswerSeen: boolean;
  pendingCollaborations: Set<string>;
  activeSubagentTurns: Set<string>;
  completionTimer: ReturnType<typeof setTimeout> | null;
  lastAgentMessage: string;
  error: { message?: string } | null;
  runtime: ProviderRuntime;
  sessionId: string;
};

const CODEX_APP_SERVER_UPGRADE_MESSAGE = 'Codex CLI does not support app-server. Update with: npm update -g @openai/codex';
const CODEX_AUTH_ERROR_MESSAGE = 'Codex CLI is not authenticated. Run "codex login" to create ~/.codex/auth.json.';
const CODEX_PREFLIGHT_CACHE_TTL_MS = 60_000;
const INFERRED_COMPLETION_DELAY_MS = 250;

type CodexContinuity = {
  cwd?: string;
  threadId?: string;
  turnId?: string;
};

type PreflightCacheEntry = {
  available: boolean;
  checkedAt: number;
};

let codexAppServerAvailabilityCache: PreflightCacheEntry | null = null;
let codexAuthTokensCache: PreflightCacheEntry | null = null;

function createProgressEvent(sessionId: string, message: string): { jobId: string; message: string; ts: string } {
  return {
    jobId: sessionId,
    message,
    ts: nowIsoString(),
  };
}

function emitProgress(state: CaptureState, message: string | null | undefined): void {
  if (!message) return;
  state.runtime.onEvent(createProgressEvent(state.sessionId, message));
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
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
  if (!normalized) return '';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function extractThreadId(message: AppServerNotification): string | null {
  return (message as { params?: { threadId?: string } }).params?.threadId ?? null;
}

function extractTurnId(message: AppServerNotification): string | null {
  const params = (message as { params?: { turnId?: string; turn?: { id?: string } } }).params;
  if (params?.turnId) return params.turnId;
  if (params?.turn?.id) return params.turn.id;
  return null;
}

function registerThread(state: CaptureState, threadId: string | null): void {
  if (!threadId) return;
  state.threadIds.add(threadId);
}

function createCaptureState(threadId: string, runtime: ProviderRuntime, sessionId: string): CaptureState {
  let resolveCompletion!: (state: CaptureState) => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<CaptureState>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    turnId: null,
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
    runtime,
    sessionId,
  };
}

function clearCompletionTimer(state: CaptureState): void {
  if (!state.completionTimer) return;
  clearTimeout(state.completionTimer);
  state.completionTimer = null;
}

function completeTurn(state: CaptureState, turn: Turn | null = null): void {
  if (state.completed) return;
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
  state.resolveCompletion(state);
}

function scheduleInferredCompletion(state: CaptureState): void {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) return;
  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) return;

  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) return;
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) return;
    completeTurn(state);
  }, INFERRED_COMPLETION_DELAY_MS);
  state.completionTimer.unref?.();
}

function belongsToTurn(state: CaptureState, message: AppServerNotification): boolean {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || trackedTurnId === messageTurnId;
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
  state: CaptureState,
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
  state: CaptureState,
  notification: { params?: Record<string, unknown> },
  lifecycle: 'started' | 'completed',
  describe: (item: Record<string, unknown>) => string | null,
): void {
  const params = notification.params as { item?: Record<string, unknown>; threadId?: string } | undefined;
  if (!params?.item) return;

  recordItem(state, params.item, lifecycle, params.threadId ?? null);
  emitProgress(state, describe(params.item));
}

function applyNotification(state: CaptureState, message: AppServerNotification): void {
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
      if (threadId && threadId !== state.threadId) {
        state.activeSubagentTurns.add(threadId);
      }
      emitProgress(state, `Turn started (${turnId ?? 'unknown'}).`);
      return;
    }
    case 'item/started': {
      handleItemNotification(state, notification, 'started', describeStartedItem);
      return;
    }
    case 'item/completed': {
      handleItemNotification(state, notification, 'completed', describeCompletedItem);
      return;
    }
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
  return turnId
    ? { cwd, threadId, turnId }
    : { cwd, threadId };
}

function continuityWithClearedTurnId(continuity: ProviderContinuityBlob | undefined): ProviderContinuityBlob | undefined {
  const { cwd, threadId } = toCodexContinuity(continuity);
  if (!threadId) {
    return undefined;
  }
  return {
    ...(cwd ? { cwd } : {}),
    threadId,
  };
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

async function captureTurn(
  lease: ProviderServerLease,
  threadId: string,
  request: ProviderRequest,
  runtime: ProviderRuntime,
  options?: {
    onTurnStarted?: (turnId: string) => void;
  },
): Promise<CaptureState> {
  const state = createCaptureState(threadId, runtime, request.sessionId);
  let interruptRequested: Promise<void> | null = null;
  const transportClosed = lease.closed.then((outcome) => {
    if (state.completed) {
      return state;
    }
    const error =
      outcome instanceof Error ? outcome : new Error('Codex app-server transport closed before the turn completed.');
    state.rejectCompletion(error);
    throw error;
  });
  void transportClosed.catch(() => {});
  const unsubscribe = lease.subscribe((message) => {
    if (!state.turnId) {
      state.bufferedNotifications.push(message);
      return;
    }

    if (message.method === 'thread/started' || message.method === 'thread/name/updated') {
      applyNotification(state, message);
      return;
    }

    if (!belongsToTurn(state, message)) {
      return;
    }

    applyNotification(state, message);
  });
  const requestInterrupt = (): void => {
    if (!state.turnId || interruptRequested) {
      return;
    }
    interruptRequested = interruptTurn(lease, threadId, state.turnId).catch(() => {});
  };
  const onAbort = () => {
    requestInterrupt();
  };
  runtime.signal.addEventListener('abort', onAbort, { once: true });

  try {
    if (runtime.signal.aborted) {
      completeTurn(state, {
        id: 'interrupted-before-turn-start',
        status: 'interrupted',
      });
      return await state.completion;
    }

    const response = await rpc(lease, 'turn/start', mapTurnStartParams(request, threadId));
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(threadId, state.turnId);
      options?.onTurnStarted?.(state.turnId);
      if (runtime.signal.aborted) {
        requestInterrupt();
      }
    }

    for (const buffered of state.bufferedNotifications) {
      if (belongsToTurn(state, buffered)) {
        applyNotification(state, buffered);
      }
    }
    state.bufferedNotifications.length = 0;

    if (response.turn?.status && response.turn.status !== 'inProgress') {
      completeTurn(state, response.turn);
    }

    return await Promise.race([state.completion, transportClosed]);
  } finally {
    clearCompletionTimer(state);
    runtime.signal.removeEventListener('abort', onAbort);
    unsubscribe();
  }
}

async function preflight(): Promise<void> {
  assertCodexAppServerAvailable();
  await assertCodexAuthTokens();
}

function assertCodexAppServerAvailable(): void {
  const now = Date.now();
  if (codexAppServerAvailabilityCache && now - codexAppServerAvailabilityCache.checkedAt < CODEX_PREFLIGHT_CACHE_TTL_MS) {
    if (!codexAppServerAvailabilityCache.available) {
      throw new Error(CODEX_APP_SERVER_UPGRADE_MESSAGE);
    }
    return;
  }

  const result = spawnSync('codex', ['app-server', '--help'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const available = !result.error && result.status === 0;
  codexAppServerAvailabilityCache = { available, checkedAt: now };
  if (!available) {
    throw new Error(CODEX_APP_SERVER_UPGRADE_MESSAGE);
  }
}

async function assertCodexAuthTokens(): Promise<void> {
  const now = Date.now();
  if (codexAuthTokensCache && now - codexAuthTokensCache.checkedAt < CODEX_PREFLIGHT_CACHE_TTL_MS) {
    if (!codexAuthTokensCache.available) {
      throw new Error(CODEX_AUTH_ERROR_MESSAGE);
    }
    return;
  }

  const authPath = join(homedir(), '.codex', 'auth.json');
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(authPath, 'utf8')) as unknown;
  } catch {
    codexAuthTokensCache = { available: false, checkedAt: now };
    throw new Error(CODEX_AUTH_ERROR_MESSAGE);
  }

  const available = hasCodexAuthTokens(parsed);
  codexAuthTokensCache = { available, checkedAt: now };
  if (!available) {
    throw new Error(CODEX_AUTH_ERROR_MESSAGE);
  }
}

function hasCodexAuthTokens(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const tokens = (value as { tokens?: unknown }).tokens;
  if (!tokens || typeof tokens !== 'object') return false;

  return ['access_token', 'refresh_token', 'id_token'].some((key) => {
    const token = (tokens as Record<string, unknown>)[key];
    return typeof token === 'string' && token.trim().length > 0;
  });
}

const codexAppServer: ProviderAppServerContract = {
  migrateLegacyContinuity(meta) {
    const continuity: ProviderContinuityBlob = {};
    if (typeof meta.provider === 'string' && meta.provider.length > 0) {
      continuity.provider = meta.provider;
    }
    if (typeof meta.threadId === 'string' && meta.threadId.length > 0) {
      continuity.threadId = meta.threadId;
    }
    if (typeof meta.turnId === 'string' && meta.turnId.length > 0) {
      continuity.turnId = meta.turnId;
    }
    return Object.keys(continuity).length > 0 ? continuity : undefined;
  },
  buildServerSpec(persistedContinuity, request) {
    const { cwd } = toCodexContinuity(persistedContinuity);
    return buildCodexProviderServerSpec(cwd ?? request.cwd ?? process.cwd(), request.coralEnv);
  },
  async interrupt(lease, continuity) {
    const parsed = toCodexContinuity(continuity);
    if (!parsed.threadId || !parsed.turnId) {
      return;
    }
    await interruptTurn(lease, parsed.threadId, parsed.turnId);
  },
  async probe(lease, continuity) {
    const parsed = toCodexContinuity(continuity);
    const updatedContinuity = continuityWithClearedTurnId(continuity);
    if (!parsed.threadId) {
      return { resumable: false, updatedContinuity };
    }

    try {
      // Probe only checks thread existence — sandbox is intentionally omitted because
      // no commands execute during probe, so the sandbox policy is irrelevant.
      await rpc(lease, 'thread/resume', {
        threadId: parsed.threadId,
        cwd: parsed.cwd ?? process.cwd(),
        model: null,
        approvalPolicy: 'never',
      });
      return {
        resumable: true,
        updatedContinuity,
      };
    } catch (error) {
      if (!isMissingConversationError(error)) {
        throw error;
      }
      return {
        resumable: false,
        updatedContinuity,
      };
    }
  },
  finalizeInterrupted(probeResult, continuity) {
    const nextContinuity = probeResult.updatedContinuity ?? continuityWithClearedTurnId(continuity);
    const parsed = toCodexContinuity(nextContinuity ?? continuity);
    if (probeResult.resumable && parsed.threadId) {
      return {
        conversationRef: parsed.threadId,
        ...(nextContinuity ? { continuityMutation: nextContinuity } : {}),
      };
    }
    return {
      nonResumable: true,
      ...(nextContinuity ? { continuityMutation: nextContinuity } : {}),
    };
  },
};

async function execute(request: ProviderRequest, runtime: ProviderRuntime): Promise<ProviderResult> {
  if (request.action === 'fork') {
    throw new Error('Codex app-server fork is unsupported until clone/fork RPC is available.');
  }

  const { acquireServer, checkpointRecovery } = requireAppServerRuntime(runtime, 'Codex');
  const startedAt = Date.now();
  const cwd = request.cwd ?? process.cwd();
  const model = resolveModelTier(request.model);
  const spec = codexAppServer.buildServerSpec(runtime.persistedContinuity, request);
  const lease = await acquireServer(spec);

  const checkpoint = (threadId: string, turnId?: string): void => {
    checkpointRecovery({
      conversationRef: threadId,
      providerMeta: { providerContinuity: buildCodexContinuity(cwd, threadId, turnId) },
    });
  };

  try {
    let threadId: string;
    let checkpointedTurnId: string | null = null;

    if (request.action === 'resume') {
      const conversationRef = requireConversationRef(request, 'resume');
      try {
        const response = await rpc(lease, 'thread/resume', mapThreadResumeParams(request, conversationRef));
        threadId = response.thread.id;
      } catch (error) {
        if (isMissingConversationError(error)) {
          return {
            content: '',
            durationMs: Date.now() - startedAt,
            nonResumable: true,
            notice: `Conversation ${conversationRef} is no longer resumable because the saved thread is missing or invalid.`,
            errors: [errorMessage(error)],
          };
        }
        throw error;
      }
    } else {
      const response = await rpc(lease, 'thread/start', mapThreadStartParams(request));
      threadId = response.thread.id;
    }

    checkpoint(threadId);
    runtime.onEvent(createProgressEvent(request.sessionId, `Thread ready (${threadId}).`));

    if (runtime.signal.aborted) {
      return {
        content: '',
        conversationRef: threadId,
        model,
        durationMs: Date.now() - startedAt,
        aborted: true,
      };
    }

    const turnState = await captureTurn(lease, threadId, request, runtime, {
      onTurnStarted: (turnId) => {
        checkpointedTurnId = turnId;
        checkpoint(threadId, turnId);
      },
    });
    if (turnState.turnId && turnState.turnId !== checkpointedTurnId) {
      checkpoint(threadId, turnState.turnId);
    }

    const turnStatus = turnState.finalTurn?.status;
    const turnFailed = !isSuccessfulTurn(turnStatus);
    const turnAborted = isAbortedTurn(turnStatus);

    checkpoint(threadId);

    if (turnFailed && !turnAborted && !turnState.lastAgentMessage.trim() && turnState.error?.message) {
      throw new Error(turnState.error.message);
    }

    return {
      content: turnState.lastAgentMessage,
      conversationRef: threadId,
      model,
      durationMs: Date.now() - startedAt,
      aborted: turnAborted || undefined,
      exitCode: turnFailed ? 1 : 0,
      notice: turnFailed && turnState.error?.message ? turnState.error.message : undefined,
      errors: turnState.error?.message ? [turnState.error.message] : undefined,
    };
  } finally {
    lease.release();
  }
}

export const codexProvider: Provider = {
  name: 'codex',
  execute,
  preflight,
  appServer: codexAppServer,
};
