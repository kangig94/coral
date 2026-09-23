import { resolve } from 'node:path';

import { errorMessage } from '../../infra/error-format.js';
import type {
  EffortLevel,
  ProviderInstruction,
  ProviderPreflightInput,
  ProviderPreflightOutcome,
} from '../../providers/contract.js';
import type { BoundProvider } from '../../providers/bound-provider-contract.js';
import { type JobLaunchRequest, type RefusedLaunchDecision, refuseLaunch } from '../../jobs/launch.js';
import {
  AgentNotFoundError,
  AgentNamespaceNotFoundError,
  InvalidAgentMetadataError,
  InvalidAgentRefError,
  parseAgentMeta,
  parseAgentRef,
  resolveAgent,
  stripAgentMetadata,
  type AgentResolutionContext,
} from '../../jobs/agent-resolution.js';
import type { SessionAllocateOptions } from '../../sessions/contracts.js';
import { describeSessionInterrupted, type SessionInterruptedFault } from '../../sessions/fault.js';
import { documentedCoralSetupError } from '../../runtime/errors.js';
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

export type ResolvedAgentLaunchProfile = {
  agentName: string;
  name: string;
  model?: string;
  effort?: EffortLevel;
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

export function mapResolverError(err: unknown): RefusedLaunchDecision | null {
  if (err instanceof InvalidAgentRefError || err instanceof InvalidAgentMetadataError) {
    return refuseLaunch('invalid_agent', err.message);
  }
  if (err instanceof AgentNotFoundError) return refuseLaunch('agent_not_found', err.message);
  if (err instanceof AgentNamespaceNotFoundError) return refuseLaunch('agent_namespace_not_found', err.message);
  return null;
}

export function normalizeCoralIntent(input: CoralIntent): CanonicalCoralIntent | RefusedLaunchDecision {
  const { sessionId, ...rest } = input;
  if (sessionId === undefined) {
    return rest;
  }
  if (sessionId.length === 0) {
    return refuseLaunch('invalid_request', 'Session ID is required when provided.');
  }
  return { ...rest, sessionId };
}

/** The frontmatter range Claude Code's native agents also accept; `ultra` exists only on Codex. */
const AGENT_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly EffortLevel[];

function isAgentEffortLevel(value: string): value is (typeof AGENT_EFFORT_LEVELS)[number] {
  return (AGENT_EFFORT_LEVELS as readonly string[]).includes(value);
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
  const effort = meta.effort;
  if (effort !== undefined && !isAgentEffortLevel(effort)) {
    throw new InvalidAgentMetadataError(
      `Agent ${canonicalName} frontmatter declares effort "${effort}". Valid values: ${AGENT_EFFORT_LEVELS.join(', ')}`,
    );
  }

  return {
    agentName: canonicalName,
    name: canonicalName,
    model: meta.model,
    ...(effort !== undefined ? { effort } : {}),
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
  cwd: string,
  requestEnv: Readonly<Record<string, string>>,
): Omit<ProviderPreflightInput, 'access'> {
  const absoluteCwd = resolve(runtime.env.cwd(), cwd || '.');
  return {
    process: runtime.process,
    storage: runtime.storage,
    env: runtime.env,
    time: runtime.time,
    cwd: absoluteCwd,
    baseEnv: runtime.env.fullSnapshot(),
    requestEnv: Object.freeze({ ...requestEnv }),
    platform: runtime.env.platform(),
  };
}

export const PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS = 27_000;
export const PROVIDER_PREFLIGHT_RETRY_BACKOFF_MS = 1_000;

export type PreflightDecision =
  | { kind: 'satisfied' }
  | { kind: 'refused'; message: string }
  | { kind: 'undetermined'; cause: 'provider' | 'deadline'; message: string };

function deadlinePreflightDecision(provider: BoundProvider): PreflightDecision {
  return {
    kind: 'undetermined',
    cause: 'deadline',
    message: `Coral could not complete the ${provider.name} availability check within ${PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS}ms. Repeat the request; if it times out again, verify that the ${provider.name} CLI starts promptly for the user running the Coral daemon.`,
  };
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * A provider that answers outside its own union has not answered, and recognising the discriminator is not
 * enough to say it did: `refused` and `undetermined` are read for their message, and one that is absent or
 * blank reaches the operator as a wire body promising a reason and carrying none. Anything this cannot
 * classify throws, because a preflight that produced no answer is an internal fault and not a fourth answer.
 */
function classifyProviderPreflightOutcome(outcome: ProviderPreflightOutcome): PreflightDecision {
  switch (outcome.kind) {
    case 'satisfied':
      return { kind: 'satisfied' };
    case 'refused':
      if (isNonBlankString(outcome.message)) {
        return { kind: 'refused', message: outcome.message };
      }
      break;
    case 'undetermined':
      if (isNonBlankString(outcome.message)) {
        return { kind: 'undetermined', cause: 'provider', message: outcome.message };
      }
      break;
    default:
      break;
  }
  throw new Error(`provider availability check returned an outcome outside its contract: ${JSON.stringify(outcome)}`);
}

function runPreflightWithTimeout(
  provider: BoundProvider,
  runtime: Omit<ProviderPreflightInput, 'access'>,
  deadline: bigint,
): Promise<PreflightDecision> {
  const remaining = deadline - runtime.time.monotonicNow();
  if (remaining <= 0n) {
    return Promise.resolve(deadlinePreflightDecision(provider));
  }

  return new Promise<PreflightDecision>((resolve, reject) => {
    let settled = false;
    const timeout = runtime.time.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(deadlinePreflightDecision(provider));
    }, Number(remaining));
    timeout.unref?.();

    const rejectWith = (error: unknown): void => {
      settled = true;
      runtime.time.clearTimeout(timeout);
      reject(
        documentedCoralSetupError('provider_preflight_faulted', {
          provider: provider.name,
          cause: errorMessage(error),
        }),
      );
    };

    Promise.resolve()
      .then(() => provider.preflight(runtime))
      .then(
        (outcome) => {
          if (settled) {
            return;
          }
          // No path may cancel the timer without settling this promise: once the timer is gone nothing else
          // will, and a launch awaiting an unsettled preflight never returns.
          let decision: PreflightDecision;
          try {
            decision =
              runtime.time.monotonicNow() >= deadline
                ? deadlinePreflightDecision(provider)
                : classifyProviderPreflightOutcome(outcome);
          } catch (error: unknown) {
            rejectWith(error);
            return;
          }
          settled = true;
          runtime.time.clearTimeout(timeout);
          resolve(decision);
        },
        (error: unknown) => {
          if (settled) {
            return;
          }
          rejectWith(error);
        },
      );
  });
}

export async function runProviderPreflight(
  provider: BoundProvider,
  runtime: Omit<ProviderPreflightInput, 'access'>,
): Promise<PreflightDecision> {
  const deadline = runtime.time.monotonicNow() + BigInt(PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS);
  let isFinalProbe = false;
  while (true) {
    const decision = await runPreflightWithTimeout(provider, runtime, deadline);
    // Only a returned provider non-answer may authorize another probe: a deadline may leave the
    // prior probe in flight.
    if (decision.kind !== 'undetermined' || decision.cause !== 'provider') {
      return decision;
    }

    if (isFinalProbe) {
      return decision;
    }

    const remaining = deadline - runtime.time.monotonicNow();
    if (remaining <= 0n) {
      return decision;
    }
    if (remaining <= BigInt(PROVIDER_PREFLIGHT_RETRY_BACKOFF_MS)) {
      isFinalProbe = true;
      continue;
    }

    await runtime.time.sleep(PROVIDER_PREFLIGHT_RETRY_BACKOFF_MS);
  }
}
