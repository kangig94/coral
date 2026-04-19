import { resolveInjectMd } from '../inject.js';
import { isRecord } from '../../shared/utils.js';
import type { ProviderRequest } from '../protocol.js';
import { resolveModelTier } from '../../shared/schemas.js';
import type { ClaudeBootstrapSignature } from '../claude-appserver/protocol.js';
import { brokerNotificationMethods } from '../claude-appserver/protocol.js';
import {
  buildProviderFailureMessage,
  type AppServerSessionDriver,
  type DriverContext,
  type DriverStepOutcome,
  type TurnOutcome,
} from '../app-server/driver.js';
import type { ProviderServerLease } from '../types.js';
import {
  buildClaudeContinuity,
  buildClaudeEnvHash,
  buildClaudeProviderServerSpec,
  mapInterruptParams,
  mapSessionEnsureParams,
  mapTurnStartParams,
  readClaudePersistedContinuity,
} from './request-mapping.js';
import { readBootstrapSignature, readString } from './shared-utils.js';

export const OUTPUT_STYLE_OVERRIDE =
  'Ignore any output-style instructions (e.g. Explanatory, Learning). No insight blocks. Be concise and direct.';

type PreparedClaudeRequest = {
  prompt: string;
  systemPrompt?: string;
  model?: string;
};

type ClaudeCompletedTurn = {
  content: string;
  model?: string;
  durationMs: number;
  errors: string[];
  costUsd?: number;
  isError: boolean;
};

export type ClaudeTurnState = {
  ctx: DriverContext;
  startedAt: number;
  prepared: PreparedClaudeRequest;
  envHash: string;
  brokerSessionKey?: string;
  bootstrapSignature?: ClaudeBootstrapSignature;
  conversationRef?: string;
  brokerTurnId?: string;
  turnRequested: boolean;
  interruptRequest: Promise<void> | null;
  completed: boolean;
  terminal: Promise<TurnOutcome>;
  resolveTerminal: (outcome: TurnOutcome) => void;
};

function brokerRpc<R = unknown>(
  lease: ProviderServerLease,
  method: string,
  params: Record<string, unknown> | object,
): Promise<R> {
  return lease.rpc<R>(method, params as unknown as Record<string, unknown>);
}

function resolveClaudeModel(model: string | undefined, env: Record<string, string>): string | undefined {
  const cap = env.CORAL_CLAUDE_MODEL_CAP ?? 'opus';
  return resolveModelTier(model, cap);
}

function buildClaudeArgs(request: ProviderRequest): { prompt: string; systemPrompt?: string } {
  const systemParts: string[] = [];
  let prompt = request.prompt;

  const injectMd = resolveInjectMd(request.cwd, request.coralEnv?.CORAL_OWNER);
  if (injectMd) {
    systemParts.push(injectMd);
  }

  if (request.instruction) {
    if (request.instruction.channel === 'system') {
      systemParts.push(request.instruction.content);
    } else {
      prompt = `${request.instruction.content}\n\n---\n\n${request.prompt}`;
    }
  }

  if (request.systemPrompt) {
    systemParts.push(request.systemPrompt);
  }

  systemParts.push(OUTPUT_STYLE_OVERRIDE);

  return {
    prompt,
    systemPrompt: systemParts.join('\n\n'),
  };
}

function buildPreparedRequest(request: ProviderRequest): PreparedClaudeRequest {
  const { prompt, systemPrompt } = buildClaudeArgs(request);
  return {
    prompt,
    systemPrompt,
    model: resolveClaudeModel(request.model, request.coralEnv),
  };
}

function checkpoint(state: ClaudeTurnState): void {
  if (!state.bootstrapSignature) {
    return;
  }

  const providerContinuity = buildClaudeContinuity({
    ...(state.brokerSessionKey ? { brokerSessionKey: state.brokerSessionKey } : {}),
    bootstrapSignature: state.bootstrapSignature,
    envHash: state.envHash,
    ...(state.conversationRef ? { conversationRef: state.conversationRef } : {}),
    ...(state.brokerTurnId ? { brokerTurnId: state.brokerTurnId } : {}),
  });

  state.ctx.checkpointRecovery({
    ...(state.conversationRef ? { conversationRef: state.conversationRef } : {}),
    providerMeta: {
      ...providerContinuity,
      ...(state.conversationRef ? { sessionId: state.conversationRef } : {}),
      providerContinuity,
    },
  });
}

function resolveTerminalOnce(state: ClaudeTurnState, outcome: TurnOutcome): void {
  if (state.completed) {
    return;
  }
  state.completed = true;
  state.resolveTerminal(outcome);
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

export const claudeSessionDriver: AppServerSessionDriver<ClaudeTurnState> = {
  name: 'Claude persistent',
  faultProviderName: 'claude',
  subscriptionPhase: 'beforeInitialize',

  buildServerSpec(_request, _persistedContinuity) {
    return buildClaudeProviderServerSpec();
  },

  createInitialState(ctx, request) {
    const persistedContinuity = readClaudePersistedContinuity(ctx.runtime.persistedContinuity);
    let resolveTerminal!: (outcome: TurnOutcome) => void;
    const terminal = new Promise<TurnOutcome>((resolve) => {
      resolveTerminal = resolve;
    });

    return {
      ctx,
      startedAt: Date.now(),
      prepared: buildPreparedRequest(request),
      envHash: buildClaudeEnvHash(request.coralEnv),
      brokerSessionKey: persistedContinuity.brokerSessionKey,
      bootstrapSignature: persistedContinuity.bootstrapSignature,
      conversationRef: persistedContinuity.conversationRef,
      brokerTurnId: undefined,
      turnRequested: false,
      interruptRequest: null,
      completed: false,
      terminal,
      resolveTerminal,
    };
  },

  async initialize(ctx, state, request) {
    const ensureResult = await brokerRpc<Record<string, unknown>>(
      ctx.lease,
      'session/ensure',
      mapSessionEnsureParams(request, state.prepared.systemPrompt, ctx.runtime.persistedContinuity),
    );
    state.brokerSessionKey = readString(ensureResult.brokerSessionKey) ?? state.brokerSessionKey;
    state.bootstrapSignature = readBootstrapSignature(ensureResult.bootstrapSignature);
    state.conversationRef = readTurnConversationRef(ensureResult) ?? state.conversationRef;
    if (!state.brokerSessionKey) {
      throw new Error('Claude broker session key missing from session/ensure response.');
    }
    checkpoint(state);
    return {};
  },

  async startTurn(ctx, state, request): Promise<DriverStepOutcome> {
    state.turnRequested = true;
    const startParams = mapTurnStartParams(
      {
        ...request,
        model: state.prepared.model,
      },
      state.prepared.prompt,
      state.brokerSessionKey ?? '',
    );
    const startResult = await brokerRpc<Record<string, unknown>>(ctx.lease, 'turn/start', startParams);
    state.brokerTurnId = readString(startResult.brokerTurnId) ?? startParams.brokerTurnId;
    state.conversationRef = readTurnConversationRef(startResult) ?? state.conversationRef;
    checkpoint(state);
    return {};
  },

  applyNotification(state, message) {
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
      message.method === turnProgress ||
      message.method === turnCompleted ||
      message.method === turnFailed;
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
      checkpoint(state);
      return;
    }

    if (message.method === turnProgress) {
      if (typeof params.message === 'string' && params.message.length > 0) {
        state.ctx.emitProgress(params.message);
      }
      return;
    }

    if (message.method === turnCompleted) {
      state.brokerTurnId = undefined;
      checkpoint(state);

      const costUsd = typeof params.costUsd === 'number' ? params.costUsd : undefined;
      const content = typeof params.result === 'string' ? params.result : '';
      const model = typeof params.model === 'string' ? params.model : state.prepared.model;
      const isError = params.isError === true;
      const errors = readErrors(params.errors);
      resolveTerminalOnce(state, {
        kind: 'completed',
        turn: {
          content,
          model,
          durationMs: typeof params.durationMs === 'number' ? params.durationMs : Date.now() - state.startedAt,
          errors,
          isError,
          ...(costUsd !== undefined ? { costUsd } : {}),
        } satisfies ClaudeCompletedTurn,
      });
      return;
    }

    if (message.method === turnFailed) {
      state.brokerTurnId = undefined;
      checkpoint(state);
      resolveTerminalOnce(state, {
        kind: 'failed',
        message: buildProviderFailureMessage('Claude', readString(params.message), readString(params.status)),
      });
    }
  },

  async awaitTurnOutcome(state) {
    return state.terminal;
  },

  async requestInterrupt(ctx, state) {
    if (!state.turnRequested || !state.brokerSessionKey) {
      return;
    }
    state.interruptRequest ??= brokerRpc<void>(
      ctx.lease,
      'turn/interrupt',
      mapInterruptParams(state.brokerSessionKey, state.brokerTurnId),
    ).catch(() => {});
    await state.interruptRequest;
  },

  onTransportClosed(_state, outcome) {
    return {
      kind: 'failed',
      message:
        outcome instanceof Error
          ? outcome.message
          : 'Claude broker transport closed before the turn completed.',
    };
  },

  finalize(state, outcome) {
    if (outcome.kind === 'completed') {
      const turn = outcome.turn as ClaudeCompletedTurn;
      const failureMessage = turn.isError ? buildProviderFailureMessage('Claude', turn.errors.join(' ')) : undefined;
      return {
        content: turn.content,
        conversationRef: state.conversationRef,
        model: turn.model,
        durationMs: turn.durationMs,
        outcome: turn.isError
          ? {
              kind: 'legacy_fault',
              fault: {
                kind: 'provider_request_failed',
                provider: 'claude',
                message: failureMessage ?? 'Claude session driver reported a failed turn.',
              },
            }
          : { kind: 'completed' },
        usage: turn.costUsd !== undefined ? { costUsd: turn.costUsd } : undefined,
      };
    }

    if (outcome.kind === 'aborted') {
      return {
        content: '',
        conversationRef: state.conversationRef,
        model: state.prepared.model,
        durationMs: Date.now() - state.startedAt,
        outcome: { kind: 'aborted', reason: outcome.reason },
      };
    }

    if (outcome.kind === 'nonResumable') {
      return {
        content: '',
        conversationRef: state.conversationRef,
        model: state.prepared.model,
        durationMs: Date.now() - state.startedAt,
        nonResumable: true,
        outcome: {
          kind: 'legacy_fault',
          fault: {
            kind: 'provider_session_unavailable',
            provider: 'claude',
            note: outcome.message,
          },
        },
      };
    }

    return {
      content: '',
      conversationRef: state.conversationRef,
      model: state.prepared.model,
      durationMs: Date.now() - state.startedAt,
      outcome: { kind: 'completed' },
    };
  },
};
