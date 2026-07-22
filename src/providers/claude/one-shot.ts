import type { StoragePort } from '../../infra/port-types.js';
import { backendLog } from '../../infra/backend-log.js';
import { isRecord, readString } from '../../infra/json.js';
import { AbortError } from '../../runtime/abort.js';
import type { IdPort } from '../../runtime/ports.js';
import type {
  EffortLevel,
  ProviderCurationCapability,
  ProviderCurationRequest,
  ProviderServerLease,
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
import type { PermissionMode } from './request-prep.js';
import { isClaudeCurationUsageBudgetExhausted } from './usage-budget.js';
import {
  claudeBaseLayer,
  claudeRoutingLayer,
  createClaudeBrokerHost,
  type ClaudeCredentialSource,
  type ClaudeExecutionPlan,
} from './execution-plan.js';

type ClaudeOneShotRequest = {
  readonly cwd: string;
  readonly prompt: string;
  readonly model?: string;
  readonly effort?: EffortLevel;
  readonly permissionMode?: Extract<PermissionMode, 'default' | 'bypassPermissions' | 'auto'>;
  readonly systemPrompt?: string;
  readonly signal?: AbortSignal;
};

type ClaudeSystemExecutionPlan = {
  readonly source: ClaudeCredentialSource;
  readonly hostPlan: ClaudeExecutionPlan['host'];
  readonly controllerEnv: Readonly<Record<string, string>>;
  readonly projectsRoot: string;
};

type ClaudeOneShotDeps = {
  readonly storage: Pick<StoragePort, 'existsSync' | 'readdirSync' | 'unlinkSync'>;
  readonly ids: Pick<IdPort, 'uuid' | 'sha256'>;
  readonly executionPlan: ClaudeSystemExecutionPlan;
  readonly acquirePreparedServer: () => Promise<ProviderServerLease>;
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
  turnRequested: boolean;
  completed: boolean;
  terminal: Promise<ClaudeOneShotOutcome>;
  resolveTerminal: (outcome: ClaudeOneShotOutcome) => void;
};

async function runClaudeOneShotTurn(deps: ClaudeOneShotDeps, request: ClaudeOneShotRequest): Promise<string> {
  const state = createOneShotState();
  const lease = await deps.acquirePreparedServer();
  const unsubscribe = lease.subscribe((message) => {
    applyOneShotNotification(state, message);
  });

  try {
    throwIfRequestAborted(request.signal, 'claude_one_shot_session_ensure');
    const ensureResult = await brokerRpc<SessionEnsureResult>(lease, 'session/ensure', {
      ...buildClaudeBootstrapSignature(
        {
          cwd: request.cwd,
          permissionMode: request.permissionMode ?? 'default',
        },
        deps.ids,
        request.systemPrompt,
      ),
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
    state.brokerSessionKey = brokerSessionKey;
    updateConversationRef(state, ensureResult);

    throwIfRequestAborted(request.signal, 'claude_one_shot_turn_start');
    state.turnRequested = true;
    const requestedTurnId = deps.ids.uuid();
    state.brokerTurnId = requestedTurnId;
    const startResult = await brokerRpc<TurnStartResult>(lease, 'turn/start', {
      brokerSessionKey: state.brokerSessionKey,
      brokerTurnId: requestedTurnId,
      prompt: request.prompt,
    });
    state.brokerTurnId = readString(startResult.brokerTurnId) ?? requestedTurnId;
    updateConversationRef(state, startResult);

    const outcome = await waitForOneShotOutcome(state, lease, request.signal);
    if (outcome.kind === 'aborted') {
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
    await closeOneShotSession(lease, state, request.signal);
    cleanupOneShotJsonl(deps, state);
    lease.release();
  }
}

export const claudeCurationCapability = Object.freeze({
  prepare(
    request: ProviderCurationRequest,
    runtime: Parameters<ProviderCurationCapability<ClaudeExecutionPlan, ClaudeCredentialSource>['prepare']>[1],
  ) {
    const executionPlan = buildClaudeSystemExecutionPlan(
      runtime.source,
      runtime.baseEnv,
      runtime.platform,
      request.cwd,
      runtime.storage,
    );
    return Object.freeze({
      hostPlan: executionPlan.hostPlan,
      turnEnv: Object.freeze({}),
      complete: ({ acquirePreparedServer }: { acquirePreparedServer: () => Promise<ProviderServerLease> }) =>
        runClaudeOneShotTurn(
          {
            storage: runtime.storage,
            ids: runtime.ids,
            executionPlan,
            acquirePreparedServer,
          },
          request,
        ),
    });
  },
  isUsageBudgetExhausted(
    runtime: Parameters<
      ProviderCurationCapability<ClaudeExecutionPlan, ClaudeCredentialSource>['isUsageBudgetExhausted']
    >[0],
  ) {
    return isClaudeCurationUsageBudgetExhausted({
      configDir: runtime.source.configDir,
      runtime,
    });
  },
}) satisfies ProviderCurationCapability<ClaudeExecutionPlan, ClaudeCredentialSource>;

function buildClaudeSystemExecutionPlan(
  source: ClaudeCredentialSource,
  baseEnv: Readonly<Record<string, string>>,
  platform: string,
  cwd: string,
  storage: Pick<StoragePort, 'existsSync'>,
): ClaudeSystemExecutionPlan {
  const broker = createClaudeBrokerHost({
    cwd,
    baseEnv,
    platform,
    storage,
    transportMode: 'print',
  });
  const controllerEnvironment = [claudeBaseLayer(baseEnv, platform), claudeRoutingLayer(source, platform)];
  return Object.freeze({
    source,
    hostPlan: Object.freeze({
      platform,
      broker,
      controller: Object.freeze({ source, environment: Object.freeze(controllerEnvironment) }),
    }),
    controllerEnv: compileEnvironmentLayers(controllerEnvironment, { platform, lifetimes: hostExecutionLifetime() }),
    projectsRoot: source.projectsRoot,
  });
}

function createOneShotState(): ClaudeOneShotState {
  let resolveTerminal!: (outcome: ClaudeOneShotOutcome) => void;
  const terminal = new Promise<ClaudeOneShotOutcome>((resolve) => {
    resolveTerminal = resolve;
  });
  return {
    turnRequested: false,
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
  lease: ProviderServerLease,
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

async function closeOneShotSession(
  lease: ProviderServerLease,
  state: ClaudeOneShotState,
  signal?: AbortSignal,
): Promise<void> {
  const brokerSessionKey = state.brokerSessionKey;
  if (brokerSessionKey === undefined) {
    return;
  }

  if (signal?.aborted && state.turnRequested) {
    await brokerRpc(lease, 'turn/interrupt', {
      brokerSessionKey,
      ...(state.brokerTurnId === undefined ? {} : { brokerTurnId: state.brokerTurnId }),
    }).catch(() => {});
  }

  await Promise.race([
    brokerRpc<SessionCloseResult>(lease, 'session/close', { brokerSessionKey }).catch(() => undefined),
    lease.closed.then(() => undefined),
  ]);
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
  lease: ProviderServerLease,
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
