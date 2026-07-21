import { resolve } from 'node:path';

import type {
  EffortLevel,
  ProviderInstruction,
  ProviderPreflightRuntime,
  ProviderSpec,
} from '../../providers/contract.js';
import type { ProviderCredentialSourceRef } from '../../infra/provider-credential-sources.js';
import { buildExactProviderEnv } from '../../providers/execution-context.js';
import type { ProviderContinuityBlob } from '../../sessions/continuity.js';
import { errorMessage } from '../../infra/error-format.js';
import { type JobLaunchRequest, type RejectedLaunchDecision, rejectLaunch } from '../../jobs/launch.js';
import {
  AgentNotFoundError,
  AgentNamespaceNotFoundError,
  InvalidAgentRefError,
  parseAgentMeta,
  parseAgentRef,
  resolveAgent,
  stripAgentMetadata,
  type AgentResolutionContext,
} from '../../jobs/agent-resolution.js';
import type { SessionAllocateOptions } from '../../sessions/contracts.js';
import { describeSessionInterrupted, type SessionInterruptedFault } from '../../sessions/fault.js';
import type { Runtime } from '../../runtime/ports.js';
import type { StepDetail } from '../../workflow/execution-contract.js';
import { SESSION_CONTROLLER_PROFILE_FIELDS, type RetentionPolicy } from '../../sessions/entry.js';
import { CONTEXT_ENV_KEY } from '../../transport/context-profile.js';

export type CoralIntent = Omit<JobLaunchRequest, 'effort' | 'agent' | 'pool' | 'retention'> & {
  sessionId?: string;
  effort?: EffortLevel;
  retention?: RetentionPolicy;
};

export type CanonicalCoralIntent = Omit<CoralIntent, 'sessionId'> & {
  sessionId?: string;
};

export const FINALIZE_CONTINUITY_MAX_RETRIES = 2;

export type ResolvedAgentLaunchProfile = {
  agentName: string;
  name: string;
  model?: string;
  instruction: ProviderInstruction;
};

export type EffectiveContinuationProfile = {
  model?: string;
  cwd: string;
  effort?: EffortLevel;
  bypassPermissions: boolean;
  systemPrompt?: string;
  instruction?: ProviderInstruction;
  controllerProfile?: SessionAllocateOptions['controllerProfile'];
  coralEnv: Record<string, string>;
  agentName?: string;
};

export function buildSessionControllerProfile(
  coralEnv: Record<string, string>,
): SessionAllocateOptions['controllerProfile'] | undefined {
  const profile: Partial<NonNullable<SessionAllocateOptions['controllerProfile']>> = {};

  for (const field of SESSION_CONTROLLER_PROFILE_FIELDS) {
    const value = coralEnv[CONTEXT_ENV_KEY[field]];
    if (value !== undefined) {
      profile[field] = value;
    }
  }

  if (Object.keys(profile).length === 0) {
    return undefined;
  }

  return profile;
}

export function mapResolverError(err: unknown): RejectedLaunchDecision | null {
  if (err instanceof InvalidAgentRefError) return rejectLaunch('invalid_agent', err.message);
  if (err instanceof AgentNotFoundError) return rejectLaunch('agent_not_found', err.message);
  if (err instanceof AgentNamespaceNotFoundError) return rejectLaunch('agent_namespace_not_found', err.message);
  return null;
}

export function normalizeCoralIntent(input: CoralIntent): CanonicalCoralIntent | RejectedLaunchDecision {
  const { sessionId, ...rest } = input;
  if (sessionId === undefined) {
    return rest;
  }
  if (sessionId.length === 0) {
    return rejectLaunch('invalid_request', 'Session ID is required when provided.');
  }
  return { ...rest, sessionId };
}

export function resolveAgentLaunchProfile(
  agentIdent: string,
  resolutionCtx: AgentResolutionContext,
): ResolvedAgentLaunchProfile {
  const ref = parseAgentRef(agentIdent);
  const resolved = resolveAgent(ref, resolutionCtx);
  const meta = parseAgentMeta(resolved.content);
  const instruction = {
    content: stripAgentMetadata(resolved.content),
    channel: 'system',
  } satisfies ProviderInstruction;
  const canonicalName = resolved.ref.name;

  return {
    agentName: canonicalName,
    name: canonicalName,
    model: meta.model,
    instruction,
  };
}

export function buildEffectiveCoralEnv(
  coralEnv: Record<string, string>,
  options: {
    effort?: string;
    controllerProfile?: SessionAllocateOptions['controllerProfile'];
  } = {},
): Record<string, string> {
  const merged = { ...coralEnv };
  const storedProfile = options.controllerProfile;

  for (const field of SESSION_CONTROLLER_PROFILE_FIELDS) {
    const envKey = CONTEXT_ENV_KEY[field];
    if (field === 'effort') {
      if (options.effort !== undefined) {
        merged[envKey] = options.effort;
        continue;
      }
    }

    const storedValue = storedProfile?.[field];
    if (storedValue !== undefined && merged[envKey] === undefined) {
      merged[envKey] = storedValue;
    }
  }

  return merged;
}

export function buildInterruptedAppServerReport(fault: SessionInterruptedFault, conversationRef?: string): string {
  const lines = [describeSessionInterrupted(fault), ''];

  if (fault.continuity === 'verified') {
    lines.push('Session is resumable. Use resume to continue.');
    if (conversationRef !== undefined) {
      lines.push(`Conversation reference preserved: ${conversationRef}`);
    }
    return lines.join('\n');
  }

  if (fault.continuity === 'missing') {
    lines.push('Session thread is no longer available. Marked as non-resumable.');
    return lines.join('\n');
  }

  if (fault.continuity === 'unavailable') {
    lines.push('Could not reach provider server to verify session. Marked as non-resumable.');
    return lines.join('\n');
  }

  lines.push(
    fault.continuity === 'pre_checkpoint_empty'
      ? 'Session was interrupted before completion. No resumable conversation was available.'
      : 'Session was interrupted before completion. The existing conversation reference was preserved.',
  );
  return lines.join('\n');
}

export function isProviderContinuityBlob(value: unknown): value is ProviderContinuityBlob {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function serializeWorkflowResult(details: StepDetail[]): {
  markdown: string;
} {
  const lines: string[] = [];

  for (const detail of details) {
    lines.push(`# Step ${detail.stepIndex}.${detail.atomIndex}: ${detail.label}`);
    lines.push('');
    const contentLines = detail.output.split('\n');
    lines.push(...contentLines);
    lines.push('');
  }

  return {
    markdown: lines.join('\n'),
  };
}

export function toPreflightRuntime(
  runtime: Runtime,
  credentialSource: ProviderCredentialSourceRef,
  cwd: string,
  requestEnv: Readonly<Record<string, string>>,
): ProviderPreflightRuntime {
  const absoluteCwd = resolve(runtime.env.cwd(), cwd || '.');
  const exactEnv = buildExactProviderEnv({
    baseEnv: runtime.env.fullSnapshot(),
    requestEnv,
    source: credentialSource,
    platform: runtime.env.platform(),
  });
  return {
    process: runtime.process,
    storage: runtime.storage,
    env: runtime.env,
    time: runtime.time,
    credentialSource,
    cwd: absoluteCwd,
    runExact: (command, args, options = {}) =>
      runtime.process.exec(command, args, { ...options, cwd: absoluteCwd, env: { ...exactEnv } }),
  };
}

export const PROVIDER_PREFLIGHT_TIMEOUT_MS = 30_000;

function runPreflightWithTimeout(provider: ProviderSpec, runtime: ProviderPreflightRuntime): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!provider.preflight) {
      resolve();
      return;
    }

    let settled = false;
    const timeout = runtime.time.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`${provider.name} preflight timed out after ${PROVIDER_PREFLIGHT_TIMEOUT_MS}ms`));
    }, PROVIDER_PREFLIGHT_TIMEOUT_MS);
    timeout.unref?.();

    Promise.resolve()
      .then(() => provider.preflight?.(runtime))
      .then(
        () => {
          if (settled) {
            return;
          }
          settled = true;
          runtime.time.clearTimeout(timeout);
          resolve();
        },
        (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          runtime.time.clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
  });
}

export async function runProviderPreflight(
  provider: ProviderSpec,
  runtime: ProviderPreflightRuntime,
): Promise<string | null> {
  if (!provider.preflight) return null;
  try {
    await runPreflightWithTimeout(provider, runtime);
    return null;
  } catch (error: unknown) {
    return errorMessage(error);
  }
}
