import { errorMessage } from '../../infra/error-format.js';
import { isRecord, readString } from '../../infra/json.js';
import type {
  Provider,
  ProviderEventBody,
  ProviderRuntime,
  ProviderServerLease,
  ProviderTerminalEventBody,
} from '../contract.js';
import { providerRequestFailed, type ProviderFailureCause } from '../fault.js';
import { sessionProviderFailureDiagnosticSchema, type SessionProviderFailureDiagnostic } from '../../sessions/fault.js';
import { bindAppServerNotificationHandler, buildProviderFailureMessage, requireAppServerLease } from '../app-server.js';
import { streamProviderEvents } from '../stream.js';
import { buildJobDiagnostics, buildJobTerminal } from '../terminal.js';
import { brokerNotificationMethods } from './appserver/protocol.js';
import {
  buildClaudeContinuity,
  buildClaudeEnvHash,
  mapInterruptParams,
  mapSessionEnsureParams,
  mapTurnStartParams,
  readClaudePersistedContinuity,
} from './request-mapping.js';
import {
  buildPreparedClaudeRequest,
  type ClaudeBootstrapSignature,
  readBootstrapSignature,
  readTurnConversationRef,
  type PreparedClaudeRequest,
} from './request-prep.js';
import { locateClaudeJsonlArtifactFromRuntime } from './artifacts.js';

function buildClaudeSessionFailureCause(
  message: string,
  diagnostic?: SessionProviderFailureDiagnostic,
): ProviderFailureCause {
  return providerRequestFailed({
    provider: 'claude',
    message,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  });
}

type ClaudeCompletedTurn = {
  content: string;
  model?: string;
  durationMs: number;
  errors: string[];
  costUsd?: number;
  isError: boolean;
};

type ClaudeTurnOutcome =
  | { kind: 'completed'; turn: ClaudeCompletedTurn }
  | { kind: 'failed'; message: string; diagnostic?: SessionProviderFailureDiagnostic }
  | { kind: 'aborted'; reason: 'signal_abort' };

type ClaudeTurnState = {
  startedAt: number;
  prepared: PreparedClaudeRequest;
  envHash: string;
  brokerSessionKey?: string;
  bootstrapSignature?: ClaudeBootstrapSignature;
  conversationRef?: string;
  artifactHandleEmissionAttempted: boolean;
  brokerTurnId?: string;
  turnRequested: boolean;
  completed: boolean;
  terminal: Promise<ClaudeTurnOutcome>;
  resolveTerminal: (outcome: ClaudeTurnOutcome) => void;
};

const claudeInterruptBindings = new WeakMap<ProviderServerLease, ClaudeTurnState>();

export async function mapClaudeInterrupt(lease: ProviderServerLease): Promise<void> {
  const state = claudeInterruptBindings.get(lease);
  if (state === undefined || !state.turnRequested || state.brokerSessionKey === undefined) {
    return;
  }

  await brokerRpc<void>(lease, 'turn/interrupt', mapInterruptParams(state.brokerSessionKey, state.brokerTurnId));
}

export const claudeSessionKernel: Provider = (request, runtime) =>
  streamProviderEvents(async (emit) => {
    const lease = requireAppServerLease(runtime, 'claude');
    const persistedContinuity = readClaudePersistedContinuity(runtime.persistedContinuity);
    const state = createInitialState(request, persistedContinuity, runtime);
    const clearBinding = bindInterruptState(lease, state);
    const clearNotificationBinding = bindAppServerNotificationHandler(runtime, (message) => {
      applyNotification(state, message, runtime, emit);
    });

    try {
      const ensureResult = await brokerRpc<Record<string, unknown>>(
        lease,
        'session/ensure',
        mapSessionEnsureParams(
          {
            ...request,
            model: state.prepared.model,
            effort: state.prepared.effort,
          },
          runtime.ids,
          state.prepared.systemPrompt,
          runtime.persistedContinuity,
        ),
      );
      state.brokerSessionKey = readString(ensureResult.brokerSessionKey) ?? state.brokerSessionKey;
      state.bootstrapSignature = readBootstrapSignature(ensureResult.bootstrapSignature);
      state.conversationRef = readTurnConversationRef(ensureResult) ?? state.conversationRef;
      if (state.brokerSessionKey === undefined) {
        throw new Error('Claude broker session key missing from session/ensure response.');
      }
      checkpointBrokerContinuity(runtime, state);
      emitClaudeArtifactHandleOnce(state, runtime, emit);

      if (runtime.signal.aborted) {
        emit(buildAbortedTerminal(state.prepared.model, state.startedAt, runtime.time.now()));
        return;
      }

      state.turnRequested = true;
      const startParams = mapTurnStartParams(state.prepared.prompt, state.brokerSessionKey, runtime.ids);
      state.brokerTurnId = startParams.brokerTurnId;
      const startResult = await brokerRpc<Record<string, unknown>>(lease, 'turn/start', startParams);
      state.brokerTurnId = readString(startResult.brokerTurnId) ?? startParams.brokerTurnId;
      state.conversationRef = readTurnConversationRef(startResult) ?? state.conversationRef;
      checkpointBrokerContinuity(runtime, state);
      emitClaudeArtifactHandleOnce(state, runtime, emit);

      const outcome = await waitForClaudeOutcome(state, lease, runtime.signal);
      if (outcome.kind === 'aborted') {
        state.brokerTurnId = undefined;
        checkpointBrokerContinuity(runtime, state);
      }

      emit(finalizeOutcome(state, outcome, runtime.time.now()));
    } catch (error) {
      if (runtime.signal.aborted) {
        emit(buildAbortedTerminal(state.prepared.model, state.startedAt, runtime.time.now()));
        return;
      }

      emit(buildFailedTerminal('', state.prepared.model, runtime.time.now() - state.startedAt, errorMessage(error)));
    } finally {
      clearNotificationBinding();
      clearBinding();
    }
  });

function createInitialState(
  request: Parameters<Provider>[0],
  persistedContinuity: ReturnType<typeof readClaudePersistedContinuity>,
  runtime: ProviderRuntime,
): ClaudeTurnState {
  let resolveTerminal!: (outcome: ClaudeTurnOutcome) => void;
  const terminal = new Promise<ClaudeTurnOutcome>((resolve) => {
    resolveTerminal = resolve;
  });

  return {
    startedAt: runtime.time.now(),
    prepared: buildPreparedClaudeRequest(
      request,
      runtime.storage,
      runtime.kbRoot,
      runtime.coralProjects,
      runtime.projectSource,
    ),
    envHash: buildClaudeEnvHash(request.coralEnv, runtime.env?.fullSnapshot() ?? request.coralEnv),
    brokerSessionKey: persistedContinuity.brokerSessionKey,
    bootstrapSignature: persistedContinuity.bootstrapSignature,
    conversationRef: persistedContinuity.conversationRef,
    artifactHandleEmissionAttempted: false,
    brokerTurnId: persistedContinuity.brokerTurnId,
    turnRequested: false,
    completed: false,
    terminal,
    resolveTerminal,
  };
}

function bindInterruptState(lease: ProviderServerLease, state: ClaudeTurnState): () => void {
  claudeInterruptBindings.set(lease, state);
  return () => {
    if (claudeInterruptBindings.get(lease) === state) {
      claudeInterruptBindings.delete(lease);
    }
  };
}

function checkpointBrokerContinuity(runtime: ProviderRuntime, state: ClaudeTurnState): void {
  if (state.bootstrapSignature === undefined) {
    return;
  }

  runtime.continuityBridge.checkpoint({
    conversationRef: state.conversationRef ?? null,
    resumable: true,
    providerContinuity: buildClaudeContinuity({
      ...(state.brokerSessionKey !== undefined ? { brokerSessionKey: state.brokerSessionKey } : {}),
      bootstrapSignature: state.bootstrapSignature,
      ...(state.envHash !== undefined ? { envHash: state.envHash } : {}),
      ...(state.conversationRef !== undefined ? { conversationRef: state.conversationRef } : {}),
      ...(state.brokerTurnId !== undefined ? { brokerTurnId: state.brokerTurnId } : {}),
    }),
  });
}

function emitClaudeArtifactHandleOnce(
  state: ClaudeTurnState,
  runtime: ProviderRuntime,
  emit: (event: ProviderEventBody) => void,
): void {
  if (state.artifactHandleEmissionAttempted || state.conversationRef === undefined) {
    return;
  }

  const result = locateClaudeJsonlArtifactFromRuntime(state.conversationRef, runtime);
  if (!result) {
    return;
  }
  if (result.kind === 'match') {
    state.artifactHandleEmissionAttempted = true;
    emit({
      kind: 'artifact_handle',
      handle: result.artifact.handle,
      ...(result.artifact.identity === undefined ? {} : { identity: result.artifact.identity }),
    });
    return;
  }
  if (result.kind === 'no_match') {
    return;
  }

  state.artifactHandleEmissionAttempted = true;
  emit({ kind: 'progress', message: result.diagnostic });
}

function resolveTerminalOnce(state: ClaudeTurnState, outcome: ClaudeTurnOutcome): void {
  if (state.completed) {
    return;
  }

  state.completed = true;
  state.resolveTerminal(outcome);
}

function applyNotification(
  state: ClaudeTurnState,
  message: { method: string; params?: Record<string, unknown> },
  runtime: ProviderRuntime,
  emit: (event: ProviderEventBody) => void,
): void {
  if (!isRecord(message)) {
    return;
  }

  const { sessionUpdated, turnProgress, turnCompleted, turnFailed, hostStats } = brokerNotificationMethods;
  if (state.brokerSessionKey === undefined && message.method !== hostStats) {
    return;
  }

  const params = isRecord(message.params) ? message.params : {};
  const messageBrokerSessionKey = readString(params.brokerSessionKey);
  if (messageBrokerSessionKey !== undefined && messageBrokerSessionKey !== state.brokerSessionKey) {
    return;
  }

  const isTurnEvent =
    message.method === turnProgress || message.method === turnCompleted || message.method === turnFailed;
  if (isTurnEvent) {
    const messageBrokerTurnId = readString(params.brokerTurnId);
    if (messageBrokerTurnId === undefined || messageBrokerTurnId !== state.brokerTurnId) {
      return;
    }
  }

  const updatedConversationRef = readTurnConversationRef(params);
  if (updatedConversationRef !== undefined) {
    state.conversationRef = updatedConversationRef;
    emitClaudeArtifactHandleOnce(state, runtime, emit);
  }

  if (message.method === sessionUpdated) {
    const updatedSignature = readBootstrapSignature(params.bootstrapSignature);
    if (updatedSignature) {
      state.bootstrapSignature = updatedSignature;
    }
    checkpointBrokerContinuity(runtime, state);
    return;
  }

  if (message.method === turnProgress) {
    if (typeof params.message === 'string' && params.message.length > 0) {
      emit({ kind: 'progress', message: params.message });
    }
    return;
  }

  if (message.method === turnCompleted) {
    state.brokerTurnId = undefined;
    checkpointBrokerContinuity(runtime, state);

    const costUsd = typeof params.costUsd === 'number' ? params.costUsd : undefined;
    const content = typeof params.result === 'string' ? params.result : '';
    const model = typeof params.model === 'string' ? params.model : state.prepared.model;
    const isError = params.isError === true;
    resolveTerminalOnce(state, {
      kind: 'completed',
      turn: {
        content,
        model,
        durationMs: typeof params.durationMs === 'number' ? params.durationMs : runtime.time.now() - state.startedAt,
        errors: readErrors(params.errors),
        isError,
        ...(costUsd === undefined ? {} : { costUsd }),
      },
    });
    return;
  }

  if (message.method === turnFailed) {
    state.brokerTurnId = undefined;
    checkpointBrokerContinuity(runtime, state);
    const diagnostic = readTurnFailureDiagnostic(params.diagnostic);
    resolveTerminalOnce(state, {
      kind: 'failed',
      message: buildProviderFailureMessage('Claude', readString(params.message), readString(params.status)),
      ...(diagnostic === undefined ? {} : { diagnostic }),
    });
  }
}

function finalizeOutcome(state: ClaudeTurnState, outcome: ClaudeTurnOutcome, nowMs: number): ProviderTerminalEventBody {
  if (outcome.kind === 'completed') {
    const failureMessage = outcome.turn.isError
      ? buildProviderFailureMessage('Claude', outcome.turn.errors.join(' '))
      : undefined;

    return {
      kind: 'terminal',
      terminal: buildJobTerminal({
        content: outcome.turn.content,
        model: outcome.turn.model,
        durationMs: outcome.turn.durationMs,
        usage: outcome.turn.costUsd === undefined ? undefined : { costUsd: outcome.turn.costUsd },
        outcome: outcome.turn.isError ? { kind: 'failed' } : { kind: 'completed' },
      }),
      diagnostics: buildJobDiagnostics({}),
      ...(outcome.turn.isError
        ? {
            failureCause: buildClaudeSessionFailureCause(
              failureMessage ?? 'Claude session driver reported a failed turn.',
            ),
          }
        : {}),
    };
  }

  if (outcome.kind === 'aborted') {
    return buildAbortedTerminal(state.prepared.model, state.startedAt, nowMs);
  }

  return buildFailedTerminal('', state.prepared.model, nowMs - state.startedAt, outcome.message, outcome.diagnostic);
}

function buildAbortedTerminal(model: string | undefined, startedAt: number, nowMs: number): ProviderTerminalEventBody {
  return {
    kind: 'terminal' as const,
    terminal: buildJobTerminal({
      content: '',
      model,
      durationMs: nowMs - startedAt,
      outcome: { kind: 'aborted', reason: 'signal_abort' },
    }),
    diagnostics: buildJobDiagnostics({}),
  };
}

function buildFailedTerminal(
  content: string,
  model: string | undefined,
  durationMs: number,
  message: string,
  diagnostic?: SessionProviderFailureDiagnostic,
): ProviderTerminalEventBody {
  return {
    kind: 'terminal' as const,
    terminal: buildJobTerminal({
      content,
      model,
      durationMs,
      outcome: { kind: 'failed' },
    }),
    diagnostics: buildJobDiagnostics({}),
    failureCause: buildClaudeSessionFailureCause(message, diagnostic),
  };
}

function brokerRpc<R = unknown>(
  lease: ProviderServerLease,
  method: string,
  params: Record<string, unknown> | object,
): Promise<R> {
  return lease.rpc<R>(method, params as Record<string, unknown>);
}

async function waitForClaudeOutcome(
  state: ClaudeTurnState,
  lease: ProviderServerLease,
  signal: AbortSignal,
): Promise<ClaudeTurnOutcome> {
  if (signal.aborted) {
    return { kind: 'aborted', reason: 'signal_abort' };
  }

  let removeAbortListener = () => {};
  const aborted = new Promise<ClaudeTurnOutcome>((resolve) => {
    const onAbort = (): void => {
      resolve({ kind: 'aborted', reason: 'signal_abort' });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => {
      signal.removeEventListener('abort', onAbort);
    };
  });

  try {
    return await Promise.race([
      state.terminal,
      lease.closed.then(
        (closed): ClaudeTurnOutcome => ({
          kind: 'failed',
          message:
            closed instanceof Error ? closed.message : 'Claude broker transport closed before the turn completed.',
        }),
      ),
      aborted,
    ]);
  } finally {
    removeAbortListener();
  }
}

function readErrors(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function readTurnFailureDiagnostic(value: unknown): SessionProviderFailureDiagnostic | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = sessionProviderFailureDiagnosticSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
