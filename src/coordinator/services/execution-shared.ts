import type {
  ProviderContinuityBlob,
  PreflightRuntime,
  ProviderInstruction,
  ProviderSpec,
} from '../../providers/contract.js';
import { errorMessage } from '../../shared/utils.js';
import type { EffortLevel } from '../../shared/schemas.js';
import type { JobLaunchRequest } from '../../jobs/launch.js';
import {
  AgentNotFoundError,
  AgentNamespaceNotFoundError,
  buildCoralInstruction,
  InvalidAgentRefError,
  parseAgentMeta,
  parseAgentRef,
  resolveAgent,
  stripAgentMetadata,
  type AgentResolutionContext,
  type LaunchDecision,
  type TerminalOutcome,
  type WorkflowResultMeta,
} from '../../jobs/api.js';
import type { SessionAllocateOptions } from '../../sessions/shell/store.js';
import type { SessionManager } from '../../sessions/shell/store.js';
import type { ProjectRequestPort } from '../contracts.js';
import {
  describeLegacyCoralFault,
  type RecoveryFaultCompat,
} from '../../shared/legacy-terminal-outcome-compat.js';
import type { Runtime } from '../../runtime/ports.js';
import type { StepDetail } from '../../workflow/api.js';
import { rejectLaunch, SessionClaimError } from '../../jobs/shell/contracts.js';
import type { ProgressStore } from '../../jobs/job-store.js';
import type { SessionEntry } from '../../sessions/api.js';
import type { ClaimJobOptions } from '../../jobs/shell/contracts.js';
import { materializeLegacyOutcome } from '../../jobs/reconcile/job-helpers.js';
import { CONTEXT_ENV_KEY, TRANSPORT_CONTEXT_FIELDS } from '../../shared/controller-profile.js';

export type ExecIntent = Parameters<ProjectRequestPort['start']>[1];
export type ResumeIntent = Parameters<ProjectRequestPort['resumeBySessionId']>[0];
export type ForkIntent = Parameters<ProjectRequestPort['forkBySessionId']>[0];
export type CoralIntent = Omit<JobLaunchRequest, 'effort' | 'agent' | 'pool'> & {
  sessionId?: string;
  effort?: EffortLevel;
};

export const FINALIZE_CONTINUITY_MAX_RETRIES = 2;
export const APP_SERVER_RECOVERY_POLICY = 'session_continuity_only' as const;

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

export type InterruptedAppServerReason = 'restart' | 'handoff';
export type InterruptedProbeOutcome = 'verified' | 'missing' | 'unavailable' | 'waiting';

export function buildSessionControllerProfile(
  coralEnv: Record<string, string>,
): SessionAllocateOptions['controllerProfile'] | undefined {
  const profile: Partial<NonNullable<SessionAllocateOptions['controllerProfile']>> = {};

  for (const field of TRANSPORT_CONTEXT_FIELDS) {
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

export function mapResolverError(err: unknown): LaunchDecision | null {
  if (err instanceof InvalidAgentRefError) return rejectLaunch('invalid_agent', err.message);
  if (err instanceof AgentNotFoundError) return rejectLaunch('agent_not_found', err.message);
  if (err instanceof AgentNamespaceNotFoundError) return rejectLaunch('agent_namespace_not_found', err.message);
  return null;
}

export function resolveAgentLaunchProfile(
  agentIdent: string,
  resolutionCtx: AgentResolutionContext,
): ResolvedAgentLaunchProfile {
  const ref = parseAgentRef(agentIdent);
  const resolved = resolveAgent(ref, resolutionCtx);
  const meta = parseAgentMeta(resolved.content);
  const instruction = buildCoralInstruction(stripAgentMetadata(resolved.content));
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

  for (const field of TRANSPORT_CONTEXT_FIELDS) {
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

export function buildInterruptedAppServerReport(
  fault: Extract<RecoveryFaultCompat, { kind: 'app_server_interrupted' }>,
  conversationRef?: string,
): string {
  const lines = [describeLegacyCoralFault(fault), ''];

  if (fault.continuity === 'verified') {
    lines.push('Session is resumable. Use resume to continue.');
    if (conversationRef) {
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

export function normalizeLegacyFaultOutcome(
  progressStore: Pick<ProgressStore, 'appendEventsWithResult'>,
  jobId: string,
  sessionId: string,
  fault: RecoveryFaultCompat,
): TerminalOutcome {
  return materializeLegacyOutcome(progressStore, { kind: 'legacy_fault', fault }, { jobId, sessionId });
}

export function isProviderContinuityBlob(value: unknown): value is ProviderContinuityBlob {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function serializeWorkflowResult(details: StepDetail[]): {
  markdown: string;
  workflow: WorkflowResultMeta;
} {
  const lines: string[] = [];
  const steps: WorkflowResultMeta['steps'] = [];

  for (const detail of details) {
    lines.push(`# Step ${detail.stepIndex}.${detail.atomIndex}: ${detail.label}`);
    lines.push('');
    const start = lines.length + 1;
    const contentLines = detail.output.split('\n');
    lines.push(...contentLines);
    const end = lines.length;
    lines.push('');

    steps.push({
      agent: detail.label,
      step: detail.stepIndex,
      atom: detail.atomIndex,
      provider: detail.provider,
      start,
      end,
    });
  }

  return {
    markdown: lines.join('\n'),
    workflow: { steps },
  };
}

export function toPreflightRuntime(runtime: Runtime): PreflightRuntime {
  return {
    process: runtime.process,
    storage: runtime.storage,
    env: runtime.env,
  };
}

export async function runProviderPreflight(
  provider: ProviderSpec,
  runtime: PreflightRuntime,
): Promise<string | null> {
  if (!provider.preflight) return null;
  try {
    await provider.preflight(runtime);
    return null;
  } catch (error: unknown) {
    return errorMessage(error);
  }
}

export async function claimJobAtomic(
  deps: {
    progressStore: Pick<ProgressStore, 'initJob' | 'rollbackJob'>;
    sessionManager: Pick<SessionManager, 'claimForJobAtomic'>;
    backendNamespace: string;
    bundleHash: string;
  },
  session: SessionEntry,
  jobId: string,
  providerName: string,
  projectRoot: string,
  options: ClaimJobOptions = {},
): Promise<SessionEntry> {
  deps.progressStore.initJob({
    jobId,
    sessionId: session.sessionId,
    provider: providerName,
    projectRoot,
    backendNamespace: deps.backendNamespace,
    bundleHash: deps.bundleHash,
    jobKind: options.jobKind,
    initialPhase: options.initialPhase ?? 'launching',
  });

  try {
    const claimed = await deps.sessionManager.claimForJobAtomic(
      session.sessionId,
      jobId,
      options.expectedVersion ?? session.version,
    );
    if (!claimed) {
      throw new SessionClaimError();
    }
    return session;
  } catch (error: unknown) {
    deps.progressStore.rollbackJob(jobId);
    throw error;
  }
}
