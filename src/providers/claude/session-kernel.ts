import { errorMessage } from '../../infra/error-format.js';
import { isRecord } from '../../infra/json.js';
import type { Provider, ProviderRuntime, ProviderServerLease, ProviderTerminalEventBody } from '../contract.js';
import { providerRequestFailed } from '../fault.js';
import {
  bindAppServerNotificationHandler,
  buildProviderFailureMessage,
  requireAppServerLease,
} from '../app-server/driver.js';
import { streamProviderEvents } from '../stream.js';
import { buildJobDiagnostics, buildJobTerminal } from '../terminal.js';
import { brokerNotificationMethods, type ClaudeBootstrapSignature } from '../claude-appserver/protocol.js';
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
  readBootstrapSignature,
  readString,
  type PreparedClaudeRequest,
} from './request-prep.js';

function buildClaudeSessionFailureCause(message: string) {
  return providerRequestFailed({
    provider: 'claude',
    message,
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
  | { kind: 'failed'; message: string }
  | { kind: 'aborted'; reason: 'signal_abort' };

type ClaudeTurnState = {
  startedAt: number;
  prepared: PreparedClaudeRequest;
  envHash: string;
  brokerSessionKey?: string;
  bootstrapSignature?: ClaudeBootstrapSignature;
  conversationRef?: string;
  brokerTurnId?: string;
  turnRequested: boolean;
  completed: boolean;
  terminal: Promise<ClaudeTurnOutcome>;
  resolveTerminal: (outcome: ClaudeTurnOutcome) => void;
};

const claudeInterruptBindings = new WeakMap<ProviderServerLease, ClaudeTurnState>();

export async function mapClaudeInterrupt(lease: ProviderServerLease): Promise<void> {
  const state = claudeInterruptBindings.get(lease);
  if (!state?.turnRequested || !state.brokerSessionKey) {
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
        mapSessionEnsureParams(request, state.prepared.systemPrompt, runtime.persistedContinuity),
      );
      state.brokerSessionKey = readString(ensureResult.brokerSessionKey) ?? state.brokerSessionKey;
      state.bootstrapSignature = readBootstrapSignature(ensureResult.bootstrapSignature);
      state.conversationRef = readTurnConversationRef(ensureResult) ?? state.conversationRef;
      if (!state.brokerSessionKey) {
        throw new Error('Claude broker session key missing from session/ensure response.');
      }
      checkpointBrokerContinuity(runtime, state);

      if (runtime.signal.aborted) {
        emit(buildAbortedTerminal(state.prepared.model, state.startedAt, runtime.time.now()));
        return;
      }

      state.turnRequested = true;
      const startParams = mapTurnStartParams(
        {
          ...request,
          model: state.prepared.model,
        },
        state.prepared.prompt,
        state.brokerSessionKey,
      );
      const startResult = await brokerRpc<Record<string, unknown>>(lease, 'turn/start', startParams);
      state.brokerTurnId = readString(startResult.brokerTurnId) ?? startParams.brokerTurnId;
      state.conversationRef = readTurnConversationRef(startResult) ?? state.conversationRef;
      checkpointBrokerContinuity(runtime, state);

      const outcome = await Promise.race([
        state.terminal,
        lease.closed.then((closed): ClaudeTurnOutcome => ({
          kind: 'failed',
          message:
            closed instanceof Error
              ? closed.message
              : 'Claude broker transport closed before the turn completed.',
        })),
      ]);

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
    prepared: buildPreparedClaudeRequest(request),
    envHash: buildClaudeEnvHash(request.coralEnv, runtime.env?.fullSnapshot() ?? request.coralEnv),
    brokerSessionKey: persistedContinuity.brokerSessionKey,
    bootstrapSignature: persistedContinuity.bootstrapSignature,
    conversationRef: persistedContinuity.conversationRef,
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
  if (!state.bootstrapSignature) {
    return;
  }

  runtime.continuityBridge.checkpoint({
    conversationRef: state.conversationRef ?? null,
    resumable: true,
    providerContinuity: buildClaudeContinuity({
      ...(state.brokerSessionKey ? { brokerSessionKey: state.brokerSessionKey } : {}),
      bootstrapSignature: state.bootstrapSignature,
      ...(state.envHash ? { envHash: state.envHash } : {}),
      ...(state.conversationRef ? { conversationRef: state.conversationRef } : {}),
      ...(state.brokerTurnId ? { brokerTurnId: state.brokerTurnId } : {}),
    }),
  });
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
  emit: (event: ReturnType<typeof buildFailedTerminal> | { kind: 'progress'; message: string }) => void,
): void {
  if (!isRecord(message)) {
    return;
  }

  const { sessionUpdated, turnProgress, turnCompleted, turnFailed, hostStats } = brokerNotificationMethods;
  if (!state.brokerSessionKey && message.method !== hostStats) {
    return;
  }

  const params = isRecord(message.params) ? message.params : {};
  if (readString(params.brokerSessionKey) && params.brokerSessionKey !== state.brokerSessionKey) {
    return;
  }

  const isTurnEvent =
    message.method === turnProgress || message.method === turnCompleted || message.method === turnFailed;
  if (isTurnEvent && state.brokerTurnId && typeof params.brokerTurnId === 'string' && params.brokerTurnId !== state.brokerTurnId) {
    return;
  }

  const updatedConversationRef = readTurnConversationRef(params);
  if (updatedConversationRef) {
    state.conversationRef = updatedConversationRef;
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
    resolveTerminalOnce(state, {
      kind: 'failed',
      message: buildProviderFailureMessage('Claude', readString(params.message), readString(params.status)),
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
        outcome: outcome.turn.isError
          ? { kind: 'failed' }
          : { kind: 'completed' },
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

  return buildFailedTerminal('', state.prepared.model, nowMs - state.startedAt, outcome.message);
}

function buildAbortedTerminal(model: string | undefined, startedAt: number, nowMs: number) {
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
) {
  return {
    kind: 'terminal' as const,
    terminal: buildJobTerminal({
      content,
      model,
      durationMs,
      outcome: { kind: 'failed' },
    }),
    diagnostics: buildJobDiagnostics({}),
    failureCause: buildClaudeSessionFailureCause(message),
  };
}

function brokerRpc<R = unknown>(
  lease: ProviderServerLease,
  method: string,
  params: Record<string, unknown> | object,
): Promise<R> {
  return lease.rpc<R>(method, params as Record<string, unknown>);
}

function readTurnConversationRef(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return readString(value.conversationRef) ?? readString(value.sessionId);
}

function readErrors(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}
