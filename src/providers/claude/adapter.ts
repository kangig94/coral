/** Claude provider adapter for the execution service. */

/** Appended to every spawned Claude subprocess to neutralize output-style hooks. */
export const OUTPUT_STYLE_OVERRIDE =
  'Ignore any output-style instructions (e.g. Explanatory, Learning). No insight blocks. Be concise and direct.';

import { executeClaudeFork, ClaudeExecParseError } from './claude-executor.js';
import { detectClaudeCli } from '../cli-detection.js';
import { resolveInjectMd } from '../inject.js';
import { extractClaudeProgressMessage } from './progress.js';
import { isRecord, nowIsoString } from '../../shared/mcp-utils.js';
import type { ProviderRequest, ProviderResult } from '../../shared/types.js';
import { mapProviderResultBase } from '../result-mapping.js';
import {
  makeOnEvent,
  requireConversationRef,
  type Provider,
  type ProviderAppServerContract,
  type ProviderRuntime,
} from '../types.js';
import { resolveModelTier, type EffortLevel } from '../../shared/schemas.js';
import type { ClaudeBootstrapSignature, SessionProbeResult } from '../claude-appserver/protocol.js';
import {
  buildClaudeEnvHash,
  buildClaudeContinuity,
  buildClaudeProviderServerSpec,
  findClaudeBootstrapDrift,
  hasClaudePersistentContinuity,
  mapInterruptParams,
  mapSessionEnsureParams,
  mapTurnStartParams,
  readClaudePersistedContinuity,
  withClaudeContinuity,
} from './request-mapping.js';
import type { ClaudeExecResult } from './types.js';

async function preflight(): Promise<void> {
  const cli = await detectClaudeCli();
  if (!cli.available) throw new Error(`Claude CLI not available: ${cli.error}`);
  if (cli.authState === 'unauthenticated') throw new Error(`Claude CLI unauthenticated: ${cli.authError}`);
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

function requirePersistentRuntime(runtime: ProviderRuntime): {
  acquireServer: NonNullable<ProviderRuntime['acquireServer']>;
  checkpointRecovery: NonNullable<ProviderRuntime['checkpointRecovery']>;
} {
  if (!runtime.acquireServer) {
    throw new Error('Claude persistent provider requires ProviderRuntime.acquireServer().');
  }
  if (!runtime.checkpointRecovery) {
    throw new Error('Claude persistent provider requires ProviderRuntime.checkpointRecovery().');
  }
  return {
    acquireServer: runtime.acquireServer,
    checkpointRecovery: runtime.checkpointRecovery,
  };
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
  derivedSystemPrompt?: string,
): string | null {
  if (!hasClaudePersistentContinuity(runtime.persistedContinuity)) {
    return null;
  }

  if (!runtime.acquireServer || !runtime.checkpointRecovery) {
    return 'This Claude session already established persistent continuity and cannot fall back to one-shot execution. Start a new Coral session.';
  }

  if (request.action === 'fork') {
    return 'This Claude session already established persistent continuity. Start a new Coral session before forking.';
  }

  const drift = findClaudeBootstrapDrift(request, derivedSystemPrompt, runtime.persistedContinuity);
  if (!drift) {
    return null;
  }

  return `This Claude session already established persistent continuity with cwd=${drift.expected.cwd}, systemPromptHash=${drift.expected.systemPromptHash}, permissionMode=${drift.expected.permissionMode}. Start a new Coral session before changing that bootstrap signature.`;
}

async function executeFork(
  request: ProviderRequest,
  runtime: ProviderRuntime,
  prepared: { prompt: string; systemPrompt?: string; model?: string; effort?: EffortLevel },
): Promise<ProviderResult> {
  const effort = request.effort as EffortLevel | undefined;
  const options = {
    model: prepared.model,
    workingDirectory: request.cwd,
    systemPrompt: prepared.systemPrompt,
    effort: prepared.effort ?? effort,
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
): Promise<ProviderResult> {
  const startedAt = Date.now();
  const { acquireServer, checkpointRecovery } = requirePersistentRuntime(runtime);
  const spec = buildClaudeProviderServerSpec(request, prepared.systemPrompt, runtime.persistedContinuity);
  const lease = await acquireServer(spec);
  const persistedContinuity = readClaudePersistedContinuity(runtime.persistedContinuity);

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
        ...(brokerSessionKey ? { brokerSessionKey } : {}),
        bootstrapSignature,
        envHash,
        ...(conversationRef ? { conversationRef, sessionId: conversationRef } : {}),
        ...(brokerTurnId ? { brokerTurnId } : {}),
        providerContinuity,
      },
    });
  };

  const requestInterrupt = (): void => {
    if (!turnRequested || interruptRequested || !brokerSessionKey) {
      return;
    }
    interruptRequested = true;
    void lease
      .rpc('turn/interrupt', mapInterruptParams(brokerSessionKey, brokerTurnId) as unknown as Record<string, unknown>)
      .catch(() => {});
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
    resolveOnce({
      content: '',
      conversationRef,
      model: prepared.model,
      durationMs: Date.now() - startedAt,
      exitCode: 1,
      notice: message,
      errors: [message],
    });
    return undefined;
  });
  void transportClosed.catch(() => {});

  const unsubscribe = lease.subscribe((message) => {
    if (!isRecord(message)) {
      return;
    }

    if (message.method === 'session/updated') {
      const params = isRecord(message.params) ? message.params : {};
      if (brokerSessionKey && readString(params.brokerSessionKey) && params.brokerSessionKey !== brokerSessionKey) {
        return;
      }
      const updatedSignature = readBootstrapSignature(params.bootstrapSignature);
      if (updatedSignature) {
        bootstrapSignature = updatedSignature;
      }
      const updatedConversationRef = readTurnConversationRef(params);
      if (updatedConversationRef) {
        conversationRef = updatedConversationRef;
      }
      checkpoint();
      return;
    }

    if (message.method === 'turn/progress') {
      const params = isRecord(message.params) ? message.params : {};
      if (brokerSessionKey && readString(params.brokerSessionKey) && params.brokerSessionKey !== brokerSessionKey) {
        return;
      }
      if (brokerTurnId && typeof params.brokerTurnId === 'string' && params.brokerTurnId !== brokerTurnId) {
        return;
      }
      if (typeof params.message === 'string' && params.message.length > 0) {
        runtime.onEvent({
          jobId: request.sessionId,
          message: params.message,
          ts: nowIsoString(),
        });
      }
      const updatedConversationRef = readTurnConversationRef(params);
      if (updatedConversationRef) {
        conversationRef = updatedConversationRef;
      }
      return;
    }

    if (message.method === 'turn/completed') {
      const params = isRecord(message.params) ? message.params : {};
      if (brokerSessionKey && readString(params.brokerSessionKey) && params.brokerSessionKey !== brokerSessionKey) {
        return;
      }
      if (brokerTurnId && typeof params.brokerTurnId === 'string' && params.brokerTurnId !== brokerTurnId) {
        return;
      }

      const updatedConversationRef = readTurnConversationRef(params);
      if (updatedConversationRef) {
        conversationRef = updatedConversationRef;
      }
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

    if (message.method === 'turn/failed') {
      const params = isRecord(message.params) ? message.params : {};
      if (brokerSessionKey && readString(params.brokerSessionKey) && params.brokerSessionKey !== brokerSessionKey) {
        return;
      }
      if (brokerTurnId && typeof params.brokerTurnId === 'string' && params.brokerTurnId !== brokerTurnId) {
        return;
      }

      const updatedConversationRef = readTurnConversationRef(params);
      if (updatedConversationRef) {
        conversationRef = updatedConversationRef;
      }
      brokerTurnId = undefined;
      checkpoint();

      const failureMessage =
        typeof params.message === 'string' && params.message.length > 0
          ? params.message
          : 'Claude broker turn failed.';
      resolveOnce({
        content: '',
        conversationRef,
        model: prepared.model,
        durationMs: Date.now() - startedAt,
        exitCode: 1,
        notice: failureMessage,
        errors: [failureMessage],
      });
    }
  });

  runtime.signal.addEventListener('abort', onAbort, { once: true });

  try {
    const ensureResult = await lease.rpc<Record<string, unknown>>(
      'session/ensure',
      mapSessionEnsureParams(request, prepared.systemPrompt, runtime.persistedContinuity) as unknown as Record<string, unknown>,
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
    const startResult = await lease.rpc<Record<string, unknown>>(
      'turn/start',
      startParams as unknown as Record<string, unknown>,
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

    const message = error instanceof Error ? error.message : String(error);
    return {
      content: '',
      conversationRef,
      model: prepared.model,
      durationMs: Date.now() - startedAt,
      exitCode: 1,
      notice: message,
      errors: [message],
    };
  } finally {
    runtime.signal.removeEventListener('abort', onAbort);
    unsubscribe();
    lease.release();
  }
}

const claudeAppServer: ProviderAppServerContract = {
  buildServerSpec(persistedContinuity, request) {
    const { systemPrompt } = buildClaudeArgs(request);
    return buildClaudeProviderServerSpec(request, systemPrompt, persistedContinuity);
  },
  async interrupt(lease, continuity) {
    const persistedContinuity = readClaudePersistedContinuity(continuity);
    if (!persistedContinuity.brokerSessionKey) {
      throw new Error('Claude broker session key missing from continuity.');
    }
    await lease.rpc(
      'turn/interrupt',
      mapInterruptParams(persistedContinuity.brokerSessionKey, persistedContinuity.brokerTurnId) as unknown as Record<string, unknown>,
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
    const continuityMutation =
      persistedContinuity.bootstrapSignature
        ? buildClaudeContinuity({
            ...(persistedContinuity.brokerSessionKey ? { brokerSessionKey: persistedContinuity.brokerSessionKey } : {}),
            bootstrapSignature: persistedContinuity.bootstrapSignature,
            ...(persistedContinuity.envHash ? { envHash: persistedContinuity.envHash } : {}),
            ...(persistedContinuity.conversationRef ? { conversationRef: persistedContinuity.conversationRef } : {}),
          })
        : undefined;

    if (probeResult.resumable && persistedContinuity.conversationRef) {
      return {
        conversationRef: persistedContinuity.conversationRef,
        ...(continuityMutation ? { continuityMutation } : {}),
      };
    }

    if (continuityMutation) {
      if (probeResult.resumable) {
        return {
          continuityMutation,
        };
      }
      return {
        nonResumable: true,
        continuityMutation,
      };
    }

    return {
      nonResumable: true,
    };
  },
};

async function execute(request: ProviderRequest, runtime: ProviderRuntime): Promise<ProviderResult> {
  const prepared = buildPreparedRequest(request);
  const redirectReason = getPersistentRedirectReason(request, runtime, prepared.systemPrompt);
  if (redirectReason) {
    return buildNewSessionRequiredResult(request, redirectReason);
  }

  if (request.action === 'fork') {
    return executeFork(request, runtime, prepared);
  }

  return executePersistent(request, runtime, prepared);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readTurnConversationRef(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return readString(value.conversationRef) ?? readString(value.sessionId);
}

function readBootstrapSignature(value: unknown): ClaudeBootstrapSignature | undefined {
  if (
    !isRecord(value) ||
    typeof value.cwd !== 'string' ||
    typeof value.systemPromptHash !== 'string' ||
    typeof value.permissionMode !== 'string'
  ) {
    return undefined;
  }
  return {
    cwd: value.cwd,
    systemPromptHash: value.systemPromptHash,
    permissionMode: value.permissionMode,
  };
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
