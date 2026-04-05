/** Claude provider adapter for the execution service. */

/** Appended to every spawned Claude subprocess to neutralize output-style hooks. */
export const OUTPUT_STYLE_OVERRIDE =
  'Ignore any output-style instructions (e.g. Explanatory, Learning). No insight blocks. Be concise and direct.';

import { executeClaudeFork, ClaudeExecParseError } from './claude-executor.js';
import { detectClaudeCli } from '../cli-detection.js';
import { resolveInjectMd } from '../inject.js';
import { extractClaudeProgressMessage } from './progress.js';
import { errorMessage, isRecord, nowIsoString } from '../../shared/mcp-utils.js';
import type { ProviderRequest, ProviderResult } from '../../shared/types.js';
import { mapProviderResultBase } from '../result-mapping.js';
import {
  makeOnEvent,
  requireAppServerRuntime,
  requireConversationRef,
  type Provider,
  type ProviderAppServerContract,
  type ProviderRuntime,
  type ProviderServerLease,
} from '../types.js';
import { resolveModelTier, type EffortLevel } from '../../shared/schemas.js';
import { brokerNotificationMethods, type SessionProbeResult } from '../claude-appserver/protocol.js';
import {
  buildClaudeBootstrapSignature,
  buildClaudeEnvHash,
  buildClaudeContinuity,
  buildClaudeProviderServerSpec,
  mapInterruptParams,
  mapSessionEnsureParams,
  mapTurnStartParams,
  readClaudePersistedContinuity,
  withClaudeContinuity,
  type ClaudePersistedContinuity,
} from './request-mapping.js';
import { readBootstrapSignature, readString, sameBootstrapSignature } from './shared-utils.js';
import type { ClaudeExecResult } from './types.js';

async function preflight(): Promise<void> {
  const cli = await detectClaudeCli();
  if (!cli.available) throw new Error(`Claude CLI not available: ${cli.error}`);
  if (cli.authState === 'unauthenticated') throw new Error(`Claude CLI unauthenticated: ${cli.authError}`);
}

function brokerRpc<R = unknown>(
  lease: ProviderServerLease,
  method: string,
  params: Record<string, unknown> | object,
): Promise<R> {
  return lease.rpc<R>(method, params as unknown as Record<string, unknown>);
}

/**
 * Build the Claude --append-system-prompt value and final prompt from ProviderRequest.
 *
 * - instruction.channel === 'system': combined system = [instruction.content, systemPrompt].join('\n\n')
 * - instruction.channel === 'prompt': instruction prepended to prompt; systemPrompt separate
 * - No instruction: systemPrompt only
 */
function buildClaudeArgs(request: ProviderRequest): { prompt: string; systemPrompt?: string } {
  const systemParts: string[] = [];
  let prompt = request.prompt;

  const injectMd = resolveInjectMd(request.cwd, request.coralEnv?.CORAL_OWNER);
  if (injectMd) systemParts.push(injectMd);

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

  // Override any output-style injected by the parent session's hooks.
  systemParts.push(OUTPUT_STYLE_OVERRIDE);

  return {
    prompt,
    systemPrompt: systemParts.join('\n\n'),
  };
}

function mapResult(result: ClaudeExecResult, fallbackConversationRef?: string): ProviderResult {
  return {
    ...mapProviderResultBase(result),
    conversationRef: result.sessionId ?? fallbackConversationRef,
    nonResumable: result.sessionId === null || result.sessionId === undefined ? true : undefined,
    usage: result.costUsd !== null && result.costUsd !== undefined ? { costUsd: result.costUsd } : undefined,
  };
}

function parseError(error: unknown, fallbackModel: string): ProviderResult | null {
  if (error instanceof ClaudeExecParseError) {
    return {
      content: '',
      notice: 'Claude CLI returned non-JSON output; result is non-resumable.',
      nonResumable: true,
      model: fallbackModel,
      exitCode: error.failure.exitCode,
      errors: [error.failure],
    };
  }
  return null;
}

function resolveClaudeModel(model: string | undefined, env: Record<string, string>): string | undefined {
  const cap = env.CORAL_CLAUDE_MODEL_CAP ?? 'opus';
  return resolveModelTier(model, cap);
}

function buildPreparedRequest(
  request: ProviderRequest,
): { prompt: string; systemPrompt?: string; model?: string; effort?: EffortLevel } {
  const { prompt, systemPrompt } = buildClaudeArgs(request);
  return {
    prompt,
    systemPrompt,
    model: resolveClaudeModel(request.model, request.coralEnv),
    effort: request.effort as EffortLevel | undefined,
  };
}

function buildNewSessionRequiredResult(request: ProviderRequest, reason: string): ProviderResult {
  return {
    content: '',
    model: resolveClaudeModel(request.model, request.coralEnv),
    nonResumable: true,
    notice: reason,
    errors: [reason],
  };
}

function getPersistentRedirectReason(
  request: ProviderRequest,
  runtime: ProviderRuntime,
  continuity: ClaudePersistedContinuity,
  derivedSystemPrompt?: string,
): string | null {
  const hasContinuity = Boolean(
    continuity.brokerSessionKey ?? continuity.bootstrapSignature ?? continuity.envHash ?? continuity.conversationRef ?? continuity.brokerTurnId,
  );
  if (!hasContinuity) {
    return null;
  }

  if (!runtime.acquireServer || !runtime.checkpointRecovery) {
    return 'This Claude session already established persistent continuity and cannot fall back to one-shot execution. Start a new Coral session.';
  }

  if (request.action === 'fork') {
    return 'This Claude session already established persistent continuity. Start a new Coral session before forking.';
  }

  if (continuity.bootstrapSignature) {
    const actual = buildClaudeBootstrapSignature(request, derivedSystemPrompt);
    if (!sameBootstrapSignature(continuity.bootstrapSignature, actual)) {
      return `This Claude session already established persistent continuity with cwd=${continuity.bootstrapSignature.cwd}, systemPromptHash=${continuity.bootstrapSignature.systemPromptHash}, permissionMode=${continuity.bootstrapSignature.permissionMode}. Start a new Coral session before changing that bootstrap signature.`;
    }
  }

  return null;
}

async function executeFork(
  request: ProviderRequest,
  runtime: ProviderRuntime,
  prepared: { prompt: string; systemPrompt?: string; model?: string; effort?: EffortLevel },
): Promise<ProviderResult> {
  const options = {
    model: prepared.model,
    workingDirectory: request.cwd,
    systemPrompt: prepared.systemPrompt,
    effort: prepared.effort,
    bypassPermissions: request.bypassPermissions,
    onEvent: makeOnEvent(runtime, request.sessionId, extractClaudeProgressMessage, request.cwd),
    runCli: runtime.runCli,
    environment: request.coralEnv,
  };

  try {
    const conversationRef = requireConversationRef(request, 'fork');
    return mapResult(await executeClaudeFork(conversationRef, prepared.prompt, options));
  } catch (error) {
    const result = parseError(error, request.model ?? 'unknown');
    if (result) return result;
    throw error;
  }
}

async function executePersistent(
  request: ProviderRequest,
  runtime: ProviderRuntime,
  prepared: { prompt: string; systemPrompt?: string; model?: string },
  persistedContinuity: ClaudePersistedContinuity,
): Promise<ProviderResult> {
  const startedAt = Date.now();
  const { acquireServer, checkpointRecovery } = requireAppServerRuntime(runtime, 'Claude persistent');
  const spec = buildClaudeProviderServerSpec();
  const lease = await acquireServer(spec);

  let brokerSessionKey = persistedContinuity.brokerSessionKey;
  let bootstrapSignature = persistedContinuity.bootstrapSignature;
  const envHash = buildClaudeEnvHash(request.coralEnv);
  let conversationRef = persistedContinuity.conversationRef;
  let brokerTurnId: string | undefined;
  let completed = false;
  let interruptRequested = false;
  let turnRequested = false;
  let resolveTerminal!: (result: ProviderResult) => void;

  const resolveOnce = (result: ProviderResult): void => {
    if (completed) {
      return;
    }
    completed = true;
    resolveTerminal(result);
  };

  const failResult = (notice: string): ProviderResult => ({
    content: '',
    conversationRef,
    model: prepared.model,
    durationMs: Date.now() - startedAt,
    exitCode: 1,
    notice,
    errors: [notice],
  });

  const terminal = new Promise<ProviderResult>((resolve) => {
    resolveTerminal = resolve;
  });

  const checkpoint = (): void => {
    if (!bootstrapSignature) {
      return;
    }

    const providerContinuity = buildClaudeContinuity({
      ...(brokerSessionKey ? { brokerSessionKey } : {}),
      bootstrapSignature,
      envHash,
      ...(conversationRef ? { conversationRef } : {}),
      ...(brokerTurnId ? { brokerTurnId } : {}),
    });

    checkpointRecovery({
      ...(conversationRef ? { conversationRef } : {}),
      providerMeta: {
        ...providerContinuity,
        ...(conversationRef ? { sessionId: conversationRef } : {}),
        providerContinuity,
      },
    });
  };

  const requestInterrupt = (): void => {
    if (!turnRequested || interruptRequested || !brokerSessionKey) {
      return;
    }
    interruptRequested = true;
    void brokerRpc(lease, 'turn/interrupt', mapInterruptParams(brokerSessionKey, brokerTurnId)).catch(() => {});
  };

  const onAbort = (): void => {
    requestInterrupt();
  };

  const transportClosed = lease.closed.then((outcome) => {
    if (completed) {
      return undefined;
    }
    const message =
      outcome instanceof Error
        ? outcome.message
        : 'Claude broker transport closed before the turn completed.';
    resolveOnce(failResult(message));
    return undefined;
  });
  void transportClosed.catch(() => {});

  const unsubscribe = lease.subscribe((message) => {
    if (!isRecord(message)) {
      return;
    }

    const { sessionUpdated, turnProgress, turnCompleted, turnFailed, hostStats } = brokerNotificationMethods;

    // Broker holds our notifications until session/ensure returns — only foreign sessions' events
    // can arrive before brokerSessionKey is assigned. host/stats has no session routing.
    if (!brokerSessionKey && message.method !== hostStats) {
      return;
    }

    const params = isRecord(message.params) ? message.params : {};
    if (readString(params.brokerSessionKey) && params.brokerSessionKey !== brokerSessionKey) {
      return;
    }

    const isTurnEvent = message.method === turnProgress || message.method === turnCompleted || message.method === turnFailed;
    if (isTurnEvent && brokerTurnId && typeof params.brokerTurnId === 'string' && params.brokerTurnId !== brokerTurnId) {
      return;
    }

    const updatedConversationRef = readTurnConversationRef(params);
    if (updatedConversationRef) {
      conversationRef = updatedConversationRef;
    }

    if (message.method === sessionUpdated) {
      const updatedSignature = readBootstrapSignature(params.bootstrapSignature);
      if (updatedSignature) {
        bootstrapSignature = updatedSignature;
      }
      checkpoint();
      return;
    }

    if (message.method === turnProgress) {
      if (typeof params.message === 'string' && params.message.length > 0) {
        runtime.onEvent({
          jobId: request.sessionId,
          message: params.message,
          ts: nowIsoString(),
        });
      }
      return;
    }

    if (message.method === turnCompleted) {
      brokerTurnId = undefined;
      checkpoint();

      const costUsd = typeof params.costUsd === 'number' ? params.costUsd : undefined;
      const content = typeof params.result === 'string' ? params.result : '';
      const model = typeof params.model === 'string' ? params.model : prepared.model;
      const isError = params.isError === true;
      const errors = readErrors(params.errors);
      resolveOnce({
        content,
        conversationRef,
        model,
        durationMs: typeof params.durationMs === 'number' ? params.durationMs : Date.now() - startedAt,
        exitCode: isError ? 1 : 0,
        notice: isError && errors.length > 0 ? errors.join(' ') : undefined,
        errors: errors.length > 0 ? errors : undefined,
        usage: costUsd !== undefined ? { costUsd } : undefined,
      });
      return;
    }

    if (message.method === turnFailed) {
      brokerTurnId = undefined;
      checkpoint();

      const failureMessage =
        typeof params.message === 'string' && params.message.length > 0
          ? params.message
          : 'Claude broker turn failed.';
      resolveOnce(failResult(failureMessage));
    }
  });

  runtime.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const ensureResult = await brokerRpc<Record<string, unknown>>(
      lease,
      'session/ensure',
      mapSessionEnsureParams(request, prepared.systemPrompt, runtime.persistedContinuity),
    );
    brokerSessionKey = readString(ensureResult.brokerSessionKey) ?? brokerSessionKey;
    bootstrapSignature = readBootstrapSignature(ensureResult.bootstrapSignature);
    conversationRef = readTurnConversationRef(ensureResult) ?? conversationRef;
    if (!brokerSessionKey) {
      throw new Error('Claude broker session key missing from session/ensure response.');
    }
    checkpoint();

    if (runtime.signal.aborted) {
      return {
        content: '',
        conversationRef,
        model: prepared.model,
        durationMs: Date.now() - startedAt,
        aborted: true,
      };
    }

    turnRequested = true;
    const startParams = mapTurnStartParams(
      {
        ...request,
        model: prepared.model,
      },
      prepared.prompt,
      brokerSessionKey,
    );
    const startResult = await brokerRpc<Record<string, unknown>>(
      lease,
      'turn/start',
      startParams,
    );
    brokerTurnId = readString(startResult.brokerTurnId) ?? startParams.brokerTurnId;
    conversationRef = readTurnConversationRef(startResult) ?? conversationRef;
    checkpoint();

    if (runtime.signal.aborted) {
      requestInterrupt();
    }

    return await Promise.race([terminal, transportClosed.then(() => terminal)]);
  } catch (error) {
    if (runtime.signal.aborted) {
      return {
        content: '',
        conversationRef,
        model: prepared.model,
        durationMs: Date.now() - startedAt,
        aborted: true,
      };
    }

    return failResult(errorMessage(error));
  } finally {
    runtime.signal.removeEventListener('abort', onAbort);
    unsubscribe();
    lease.release();
  }
}

const claudeAppServer: ProviderAppServerContract = {
  buildServerSpec(_persistedContinuity, _request) {
    return buildClaudeProviderServerSpec();
  },
  async interrupt(lease, continuity) {
    const persistedContinuity = readClaudePersistedContinuity(continuity);
    if (!persistedContinuity.brokerSessionKey) {
      throw new Error('Claude broker session key missing from continuity.');
    }
    await brokerRpc(
      lease,
      'turn/interrupt',
      mapInterruptParams(persistedContinuity.brokerSessionKey, persistedContinuity.brokerTurnId),
    );
  },
  async probe(lease, continuity) {
    const persistedContinuity = readClaudePersistedContinuity(continuity);
    if (!persistedContinuity.brokerSessionKey) {
      throw new Error('Claude broker session key missing from continuity.');
    }
    const result = await lease.rpc<SessionProbeResult>('session/probe', {
      brokerSessionKey: persistedContinuity.brokerSessionKey,
      conversationRef: persistedContinuity.conversationRef,
    });
    if (result.status === 'unavailable') {
      throw new Error('Claude broker session is unavailable.');
    }

    const updatedConversationRef = readTurnConversationRef(result) ?? persistedContinuity.conversationRef;
    const resumable = result.status === 'available' || (result.status === 'missing' && Boolean(persistedContinuity.conversationRef));
    return {
      resumable,
      updatedContinuity: withClaudeContinuity(continuity, {
        brokerSessionKey: result.brokerSessionKey ?? persistedContinuity.brokerSessionKey,
        bootstrapSignature: result.bootstrapSignature ?? persistedContinuity.bootstrapSignature,
        envHash: persistedContinuity.envHash,
        conversationRef: updatedConversationRef,
      }),
    };
  },
  finalizeInterrupted(probeResult, continuity) {
    const persistedContinuity = readClaudePersistedContinuity(probeResult.updatedContinuity ?? continuity);

    if (probeResult.resumable && persistedContinuity.conversationRef) {
      if (!persistedContinuity.bootstrapSignature) {
        return {
          conversationRef: persistedContinuity.conversationRef,
        };
      }

      return {
        conversationRef: persistedContinuity.conversationRef,
        continuityMutation: buildClaudeContinuity({
          ...(persistedContinuity.brokerSessionKey ? { brokerSessionKey: persistedContinuity.brokerSessionKey } : {}),
          bootstrapSignature: persistedContinuity.bootstrapSignature,
          ...(persistedContinuity.envHash ? { envHash: persistedContinuity.envHash } : {}),
          conversationRef: persistedContinuity.conversationRef,
        }),
      };
    }

    if (!persistedContinuity.bootstrapSignature) {
      return {
        nonResumable: true,
      };
    }

    const continuityMutation = buildClaudeContinuity({
      ...(persistedContinuity.brokerSessionKey ? { brokerSessionKey: persistedContinuity.brokerSessionKey } : {}),
      bootstrapSignature: persistedContinuity.bootstrapSignature,
      ...(persistedContinuity.envHash ? { envHash: persistedContinuity.envHash } : {}),
      ...(persistedContinuity.conversationRef ? { conversationRef: persistedContinuity.conversationRef } : {}),
    });

    if (probeResult.resumable) {
      return {
        continuityMutation,
      };
    }

    return {
      nonResumable: true,
      continuityMutation,
    };
  },
};

async function execute(request: ProviderRequest, runtime: ProviderRuntime): Promise<ProviderResult> {
  const prepared = buildPreparedRequest(request);
  const continuity = readClaudePersistedContinuity(runtime.persistedContinuity);
  const redirectReason = getPersistentRedirectReason(request, runtime, continuity, prepared.systemPrompt);
  if (redirectReason) {
    return buildNewSessionRequiredResult(request, redirectReason);
  }

  if (request.action === 'fork') {
    return executeFork(request, runtime, prepared);
  }

  return executePersistent(request, runtime, prepared, continuity);
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

export const claudeProvider: Provider = {
  name: 'claude',
  execute,
  preflight,
  appServer: claudeAppServer,
};
