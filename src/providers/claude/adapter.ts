/** Claude provider adapter for the execution service. */

export { OUTPUT_STYLE_OVERRIDE } from './session-driver.js';

import { join } from 'node:path';
import { executeClaudeFork, ClaudeExecParseError } from './claude-executor.js';
import { claudeSessionDriver, OUTPUT_STYLE_OVERRIDE } from './session-driver.js';
import { detectClaudeCli } from '../cli-detection.js';
import { resolveInjectMd } from '../inject.js';
import { extractClaudeProgressMessage } from './progress.js';
import { isRecord } from '../../shared/utils.js';
import type { ProviderRequest, ProviderResult } from '../../shared/types.js';
import { runAppServerTurn } from '../app-server/runner.js';
import { mapProviderResultBase } from '../result-mapping.js';
import {
  type ArtifactCleanupRuntime,
  makeOnEvent,
  type PreflightRuntime,
  requireConversationRef,
  type Provider,
  type ProviderAppServerLifecycle,
  type ProviderArtifactCleanup,
  type ProviderExecutor,
  type ProviderRuntime,
  type ProviderServerLease,
} from '../types.js';
import { ABSTRACT_MODEL_TIERS, parseEffortLevel, resolveModelTier, type EffortLevel } from '../../shared/schemas.js';
import type { SessionProbeResult } from '../claude-appserver/protocol.js';
import {
  buildClaudeBootstrapSignature,
  buildClaudeContinuity,
  buildClaudeProviderServerSpec,
  mapInterruptParams,
  readClaudePersistedContinuity,
  withClaudeContinuity,
  type ClaudePersistedContinuity,
} from './request-mapping.js';
import { readString, sameBootstrapSignature } from './shared-utils.js';
import type { ClaudeExecResult } from './types.js';

async function preflight(_runtime: PreflightRuntime): Promise<void> {
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
    exitCode: 0,
    conversationRef: result.sessionId ?? fallbackConversationRef,
    nonResumable: result.sessionId === null || result.sessionId === undefined ? true : undefined,
    usage: result.costUsd !== null && result.costUsd !== undefined ? { costUsd: result.costUsd } : undefined,
  };
}

function parseError(error: unknown, fallbackModel: string): ProviderResult | null {
  if (error instanceof ClaudeExecParseError) {
    return {
      content: '',
      nonResumable: true,
      model: fallbackModel,
      exitCode: error.failure.exitCode ?? null,
      outcome: {
        kind: 'coral_fault',
        fault: {
          kind: 'adapter_output_unparseable',
          provider: 'claude',
          exitCode: error.failure.exitCode ?? null,
          stdout: error.failure.stdout,
          stderr: error.failure.stderr,
          parseError: error.failure.parseError,
        },
      },
    };
  }
  return null;
}

function resolveClaudeModel(model: string | undefined, env: Record<string, string>): string | undefined {
  const cap = env.CORAL_CLAUDE_MODEL_CAP ?? 'opus';
  return resolveModelTier(model, cap);
}

const CLAUDE_DEFAULT_EFFORT: EffortLevel = 'xhigh';
const OPUS_RANK = ABSTRACT_MODEL_TIERS.opus;

function isOpusEffectiveTier(model: string | undefined, env: Record<string, string>): boolean {
  // Unknown cap strings default to opus (no restriction).
  const capRank = ABSTRACT_MODEL_TIERS[env.CORAL_CLAUDE_MODEL_CAP ?? 'opus'] ?? OPUS_RANK;
  if (model === undefined) {
    return capRank === OPUS_RANK;
  }
  const abstractRank = ABSTRACT_MODEL_TIERS[model];
  if (abstractRank !== undefined) {
    return Math.min(abstractRank, capRank) === OPUS_RANK;
  }
  if (/sonnet|haiku/i.test(model)) return false;
  return true;
}

/**
 * Precedence: explicit request effort > CORAL_CLAUDE_EFFORT > CORAL_EFFORT >
 * built-in default. Claude Sonnet/Haiku have no xhigh level, so xhigh collapses
 * to the provider ceiling (max) on those tiers.
 */
function resolveClaudeEffort(request: ProviderRequest): EffortLevel {
  const resolved =
    request.effort
    ?? parseEffortLevel(request.coralEnv.CORAL_CLAUDE_EFFORT, 'CORAL_CLAUDE_EFFORT')
    ?? parseEffortLevel(request.coralEnv.CORAL_EFFORT, 'CORAL_EFFORT')
    ?? CLAUDE_DEFAULT_EFFORT;
  if (resolved !== 'xhigh') return resolved;
  return isOpusEffectiveTier(request.model, request.coralEnv) ? 'xhigh' : 'max';
}

function buildPreparedRequest(
  request: ProviderRequest,
): { prompt: string; systemPrompt?: string; model?: string; effort: EffortLevel } {
  const { prompt, systemPrompt } = buildClaudeArgs(request);
  return {
    prompt,
    systemPrompt,
    model: resolveClaudeModel(request.model, request.coralEnv),
    effort: resolveClaudeEffort(request),
  };
}

function buildNewSessionRequiredResult(request: ProviderRequest, reason: string): ProviderResult {
  return {
    content: '',
    model: resolveClaudeModel(request.model, request.coralEnv),
    nonResumable: true,
    outcome: {
      kind: 'coral_fault',
      fault: {
        kind: 'provider_session_unavailable',
        provider: 'claude',
        note: reason,
      },
    },
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
  prepared: { prompt: string; systemPrompt?: string; model?: string; effort: EffortLevel },
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
  _prepared: { prompt: string; systemPrompt?: string; model?: string },
  _persistedContinuity: ClaudePersistedContinuity,
): Promise<ProviderResult> {
  return runAppServerTurn(claudeSessionDriver, request, runtime);
}

const claudeAppServerLifecycle: ProviderAppServerLifecycle = {
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

async function cleanupSessions(
  runtime: ArtifactCleanupRuntime,
  conversationRefs: readonly string[],
): Promise<void> {
  if (conversationRefs.length === 0) return;
  const projectsDir = join(runtime.env.homedir(), '.claude', 'projects');
  if (!runtime.storage.existsSync(projectsDir)) return;

  const targets = new Set(conversationRefs.map((id) => `${id}.jsonl`));
  const dirs = runtime.storage.readdirSync(projectsDir, { withFileTypes: true });
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = join(projectsDir, dir.name);
    const entries = runtime.storage.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !targets.has(entry.name)) continue;
      try {
        runtime.storage.unlinkSync(join(dirPath, entry.name));
      } catch {
        /* best-effort */
      }
    }
  }
}

const claudeExecutor: ProviderExecutor = {
  name: 'claude',
  execute,
  preflight,
};

const claudeArtifactCleanup: ProviderArtifactCleanup = {
  name: 'claude',
  cleanupSessions,
};

export const claudeProvider = {
  ...claudeExecutor,
  appServerLifecycle: claudeAppServerLifecycle,
  artifactCleanup: claudeArtifactCleanup,
} satisfies Provider & {
  appServerLifecycle: ProviderAppServerLifecycle;
  artifactCleanup: ProviderArtifactCleanup;
};
