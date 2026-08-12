import type { StoragePort } from '../../infra/port-types.js';
import { backendLog } from '../../infra/backend-log.js';
import { isRecord, readString } from '../../infra/json.js';
import { AbortError } from '../../runtime/abort.js';
import type { CanonicalWorkDir } from '../../runtime/canonical-work-dir.js';
import type { IdPort } from '../../runtime/ports.js';
import type {
  EffortLevel,
  AppServerSession,
  ProviderCurationCapability,
  ProviderCurationRequest,
} from '../contract.js';
import { compileEnvironmentLayers, hostExecutionLifetime } from '../execution-plan.js';
import { deleteClaudeJsonlArtifactsForConversation } from './artifacts.js';
import {
  brokerNotificationMethods,
  type SessionCloseResult,
  type SessionEnsureResult,
  type TurnStartResult,
} from './appserver/protocol.js';
import { buildClaudeBootstrapSignature } from './request-mapping.js';
import { readBootstrapSignature, sameBootstrapSignature, type PermissionMode } from './request-prep.js';
import { isClaudeCurationUsageBudgetExhausted } from './usage-budget.js';
import { buildClaudeControllerHost, type ClaudeProviderAccess } from './execution-plan.js';

type ClaudeOneShotRequest = {
  readonly cwd: CanonicalWorkDir;
  readonly prompt: string;
  readonly model?: string;
  readonly effort?: EffortLevel;
  readonly permissionMode?: Extract<PermissionMode, 'default' | 'bypassPermissions' | 'auto'>;
  readonly systemPrompt?: string;
  readonly signal?: AbortSignal;
};

type ClaudeSystemExecutionPlan = {
  readonly access: ClaudeProviderAccess;
  readonly controllerEnv: Readonly<Record<string, string>>;
  readonly projectsRoot: string;
};

type ClaudeOneShotDeps = {
  readonly storage: Pick<StoragePort, 'existsSync' | 'readdirSync' | 'unlinkSync'>;
  readonly ids: Pick<IdPort, 'uuid' | 'sha256'>;
  readonly executionPlan: ClaudeSystemExecutionPlan;
  readonly appServerSession: AppServerSession;
};

type ClaudeOneShotOutcome =
  | {
      readonly kind: 'completed';
      readonly turn: { readonly result: string; readonly isError: boolean; readonly errors: readonly string[] };
    }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'aborted' };

type ClaudeOneShotState = {
  brokerSessionKey?: string;
  brokerTurnId?: string;
  conversationRef?: string;
  completed: boolean;
  terminal: Promise<ClaudeOneShotOutcome>;
  resolveTerminal: (outcome: ClaudeOneShotOutcome) => void;
};

class UnconfirmedClaudeOneShotCancellationError extends Error {
  constructor(brokerTurnId: string, cause?: unknown) {
    super(`Claude one-shot turn ${brokerTurnId} could not be confirmed cancelled.`, { cause });
    this.name = 'UnconfirmedClaudeOneShotCancellationError';
  }
}

async function runClaudeOneShotTurn(deps: ClaudeOneShotDeps, request: ClaudeOneShotRequest): Promise<string> {
  const state = createOneShotState();
  const session = deps.appServerSession;
  const unsubscribe = session.subscribe((message) => {
    applyOneShotNotification(state, message);
  });

  try {
    throwIfRequestAborted(request.signal, 'claude_one_shot_session_ensure');
    const requestedBootstrap = buildClaudeBootstrapSignature(
      {
        cwd: request.cwd,
        permissionMode: request.permissionMode ?? 'default',
      },
      deps.ids,
      {
        derivedSystemPrompt: request.systemPrompt,
        projectsRoot: deps.executionPlan.projectsRoot,
        model: request.model,
        effort: request.effort,
      },
    );
    const ensureResult = await brokerRpc<SessionEnsureResult>(session, 'session/ensure', {
      ...requestedBootstrap,
      controllerEnv: { ...deps.executionPlan.controllerEnv },
      projectsRoot: deps.executionPlan.projectsRoot,
      ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
    });
    const brokerSessionKey = readString(ensureResult.brokerSessionKey);
    if (brokerSessionKey === undefined) {
      throw new Error('Claude one-shot broker session key missing from session/ensure response.');
    }
    const returnedBootstrap = readBootstrapSignature(ensureResult.bootstrapSignature);
    if (returnedBootstrap === undefined || !sameBootstrapSignature(returnedBootstrap, requestedBootstrap)) {
      throw new Error('Claude one-shot session/ensure did not return the exact requested bootstrap signature.');
    }
    state.brokerSessionKey = brokerSessionKey;
    updateConversationRef(state, ensureResult);

    throwIfRequestAborted(request.signal, 'claude_one_shot_turn_start');
    const requestedTurnId = deps.ids.uuid();
    state.brokerTurnId = requestedTurnId;
    const startParams = {
      brokerSessionKey: state.brokerSessionKey,
      brokerTurnId: requestedTurnId,
      prompt: request.prompt,
    };
    const startOutcome = await startOneShotBrokerTurn(session, startParams, request.signal);
    if (startOutcome.kind === 'aborted') {
      throw new AbortError({ stage: 'claude_one_shot_turn_start', reason: request.signal?.reason });
    }
    const startResult = startOutcome.result;
    if (readString(startResult.brokerSessionKey) !== state.brokerSessionKey) {
      throw new Error('Claude one-shot turn/start did not return the exact requested broker session key.');
    }
    if (readString(startResult.brokerTurnId) !== requestedTurnId) {
      throw new Error('Claude one-shot turn/start did not return the exact requested broker turn id.');
    }
    state.brokerTurnId = requestedTurnId;
    updateConversationRef(state, startResult);

    const outcome = await waitForOneShotOutcome(state, session, request.signal);
    if (outcome.kind === 'aborted') {
      await confirmOneShotCancellation(session, {
        brokerSessionKey: state.brokerSessionKey,
        brokerTurnId: state.brokerTurnId,
      });
      throw new AbortError({ stage: 'claude_one_shot_turn', reason: request.signal?.reason });
    }
    if (outcome.kind === 'failed') {
      throw new Error(outcome.message);
    }
    if (outcome.turn.isError) {
      throw new Error(failedTurnMessage(outcome.turn));
    }

    return outcome.turn.result;
  } finally {
    unsubscribe();
    await closeOneShotSession(session, state);
    cleanupOneShotJsonl(deps, state);
  }
}

async function startOneShotBrokerTurn(
  session: AppServerSession,
  params: { brokerSessionKey: string; brokerTurnId: string; prompt: string },
  signal?: AbortSignal,
): Promise<{ kind: 'started'; result: TurnStartResult } | { kind: 'aborted' }> {
  const started = brokerRpc<TurnStartResult>(session, 'turn/start', params).then((result) => ({
    kind: 'started' as const,
    result,
  }));
  if (signal === undefined) return await started;

  let removeAbortListener = () => {};
  const aborted = new Promise<{ kind: 'aborted' }>((resolve) => {
    if (signal.aborted) {
      resolve({ kind: 'aborted' });
      return;
    }
    const onAbort = (): void => resolve({ kind: 'aborted' });
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });

  try {
    const outcome = await Promise.race([started, aborted]);
    if (outcome.kind === 'started') return outcome;

    await confirmOneShotCancellation(session, {
      brokerSessionKey: params.brokerSessionKey,
      brokerTurnId: params.brokerTurnId,
    });
    return outcome;
  } finally {
    removeAbortListener();
  }
}

export const claudeCurationCapability = Object.freeze({
  prepare(
    request: ProviderCurationRequest,
    runtime: Parameters<ProviderCurationCapability<ClaudeProviderAccess>['prepare']>[1],
  ) {
    const executionPlan = buildClaudeSystemExecutionPlan(runtime);
    return Object.freeze({
      complete: ({ appServerSession }: { appServerSession: AppServerSession }) =>
        runClaudeOneShotTurn(
          {
            storage: runtime.storage,
            ids: runtime.ids,
            executionPlan,
            appServerSession,
          },
          request,
        ),
    });
  },
  isUsageBudgetExhausted(
    runtime: Parameters<ProviderCurationCapability<ClaudeProviderAccess>['isUsageBudgetExhausted']>[0],
  ) {
    return isClaudeCurationUsageBudgetExhausted({
      configDir: runtime.access.configDir,
      runtime,
    });
  },
}) satisfies ProviderCurationCapability<ClaudeProviderAccess>;

function buildClaudeSystemExecutionPlan(
  runtime: Parameters<ProviderCurationCapability<ClaudeProviderAccess>['prepare']>[1],
): ClaudeSystemExecutionPlan {
  const controller = buildClaudeControllerHost({
    access: runtime.access,
    coralEnv: { CORAL_CLAUDE_TRANSPORT: 'print' },
    baseEnv: runtime.baseEnv,
    platform: runtime.platform,
  });
  return Object.freeze({
    access: runtime.access,
    controllerEnv: compileEnvironmentLayers(controller.environment, {
      platform: runtime.platform,
      lifetimes: hostExecutionLifetime(),
    }),
    projectsRoot: runtime.access.projectsRoot,
  });
}

function createOneShotState(): ClaudeOneShotState {
  let resolveTerminal!: (outcome: ClaudeOneShotOutcome) => void;
  const terminal = new Promise<ClaudeOneShotOutcome>((resolve) => {
    resolveTerminal = resolve;
  });
  return {
    completed: false,
    terminal,
    resolveTerminal,
  };
}

function applyOneShotNotification(
  state: ClaudeOneShotState,
  message: { method: string; params?: Record<string, unknown> },
): void {
  if (!isRecord(message)) {
    return;
  }
  const params = isRecord(message.params) ? message.params : {};
  const brokerSessionKey = readString(params.brokerSessionKey);
  if (state.brokerSessionKey === undefined || brokerSessionKey !== state.brokerSessionKey) {
    return;
  }

  const brokerTurnId = readString(params.brokerTurnId);
  const { sessionUpdated, turnProgress, turnCompleted, turnFailed } = brokerNotificationMethods;
  const isTurnEvent =
    message.method === turnProgress || message.method === turnCompleted || message.method === turnFailed;
  if (isTurnEvent && (state.brokerTurnId === undefined || brokerTurnId !== state.brokerTurnId)) {
    return;
  }

  updateConversationRef(state, params);
  if (message.method === sessionUpdated || message.method === turnProgress) {
    return;
  }

  if (message.method === turnCompleted) {
    resolveTerminalOnce(state, {
      kind: 'completed',
      turn: {
        result: typeof params.result === 'string' ? params.result : '',
        isError: params.isError === true,
        errors: readErrors(params.errors),
      },
    });
    return;
  }

  if (message.method === turnFailed) {
    resolveTerminalOnce(state, {
      kind: 'failed',
      message: buildTurnFailedMessage(params),
    });
  }
}

async function waitForOneShotOutcome(
  state: ClaudeOneShotState,
  lease: AppServerSession,
  signal?: AbortSignal,
): Promise<ClaudeOneShotOutcome> {
  if (signal?.aborted) {
    return { kind: 'aborted' };
  }

  let removeAbortListener = () => {};
  const aborted = new Promise<ClaudeOneShotOutcome>((resolve) => {
    const onAbort = (): void => {
      resolve({ kind: 'aborted' });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => {
      signal?.removeEventListener('abort', onAbort);
    };
  });

  try {
    return await Promise.race([
      state.terminal,
      lease.closed.then(
        (closed): ClaudeOneShotOutcome => ({
          kind: 'failed',
          message: closed instanceof Error ? closed.message : 'Claude broker transport closed before curate completed.',
        }),
      ),
      aborted,
    ]);
  } finally {
    removeAbortListener();
  }
}

async function closeOneShotSession(lease: AppServerSession, state: ClaudeOneShotState): Promise<void> {
  const brokerSessionKey = state.brokerSessionKey;
  if (brokerSessionKey === undefined) {
    return;
  }

  await Promise.race([
    brokerRpc<SessionCloseResult>(lease, 'session/close', { brokerSessionKey }).catch(() => undefined),
    lease.closed.then(() => undefined),
  ]);
}

async function confirmOneShotCancellation(
  lease: AppServerSession,
  exactTurn: { brokerSessionKey: string; brokerTurnId: string },
): Promise<void> {
  let interruptError: unknown;
  try {
    if ((await lease.interrupt(exactTurn)).kind === 'accepted') return;
  } catch (error) {
    interruptError = error;
  }

  try {
    const outcome = await Promise.race([
      brokerRpc<SessionCloseResult>(lease, 'session/close', {
        brokerSessionKey: exactTurn.brokerSessionKey,
      }).then((result) => ({ kind: 'closed_session' as const, result })),
      lease.closed.then(() => ({ kind: 'closed_transport' as const })),
    ]);
    if (outcome.kind === 'closed_transport') return;
    if (outcome.result.closed && outcome.result.brokerSessionKey === exactTurn.brokerSessionKey) return;
  } catch (error) {
    throw new UnconfirmedClaudeOneShotCancellationError(exactTurn.brokerTurnId, error);
  }
  throw new UnconfirmedClaudeOneShotCancellationError(exactTurn.brokerTurnId, interruptError);
}

function cleanupOneShotJsonl(deps: ClaudeOneShotDeps, state: ClaudeOneShotState): void {
  if (state.conversationRef === undefined) {
    return;
  }

  const result = deleteClaudeJsonlArtifactsForConversation({
    conversationRef: state.conversationRef,
    projectsRoot: deps.executionPlan.projectsRoot,
    storage: deps.storage,
  });
  for (const cleanupError of result.errors) {
    backendLog.warn(`Claude curate JSONL cleanup failed for ${cleanupError.handle}: ${cleanupError.message}`);
  }
}

function updateConversationRef(state: ClaudeOneShotState, value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  const conversationRef = readString(value.conversationRef) ?? readString(value.sessionId);
  if (conversationRef !== undefined) {
    state.conversationRef = conversationRef;
  }
}

function resolveTerminalOnce(state: ClaudeOneShotState, outcome: ClaudeOneShotOutcome): void {
  if (state.completed) {
    return;
  }

  state.completed = true;
  state.resolveTerminal(outcome);
}

function brokerRpc<R = unknown>(
  lease: AppServerSession,
  method: string,
  params: Record<string, unknown> | object,
): Promise<R> {
  return lease.rpc<R>(method, params as Record<string, unknown>);
}

function readErrors(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function buildTurnFailedMessage(params: Record<string, unknown>): string {
  const message = readString(params.message);
  return message ?? 'Claude curate turn failed.';
}

function failedTurnMessage(turn: { readonly result: string; readonly errors: readonly string[] }): string {
  const detail = turn.errors.length > 0 ? turn.errors.join(' ') : turn.result.trim();
  return detail ? `Claude curate turn failed: ${detail}` : 'Claude curate turn failed.';
}

function throwIfRequestAborted(signal: AbortSignal | undefined, stage: string): void {
  if (signal?.aborted) {
    throw new AbortError({ stage, reason: signal.reason });
  }
}
