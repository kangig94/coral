import type {
  Provider,
  ProviderContinuityBlob,
  ProviderRecoveryMeta,
  ProviderServerLease,
  ProviderServerSpec,
} from '../providers/types.js';
import { backendLog } from '../shared/backend-log.js';
import type { AbortResult } from '../shared/execution-contracts.js';
import type { CallerContext } from '../shared/request-context.js';
import { resolveEffort, type EffortLevel, type WorkflowCommand } from '../shared/schemas.js';
import {
  isAppServerRuntime,
  isDurableCliRuntime,
  isTerminalPhase,
  type AppServerRuntimeRecord,
  type JobPhase,
  type LaunchDecision,
  type LaunchState,
  type PersistedLaunchRecord,
  type PersistedRuntimeRecord,
  type ProviderInstruction,
  type ProviderRequest,
  type ProviderResult,
  type SessionEntry,
  type TerminalResult,
  type WaitRequest,
  type WaitStreamEvent,
  type WorkflowResultMeta,
} from '../shared/types.js';
import { errorMessage, nowIsoString } from '../shared/utils.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { PipelineAST } from '../workflow/types.js';
import {
  executePipeline,
  resumePipeline,
  type PipelineResult,
  type StepDetail,
  WorkflowExecutionError,
} from '../workflow/pipe-executor.js';
import { AbortRegistry } from './abort-controller-registry.js';
import type { LaunchCoordinator, LaunchPool } from './engine.js';
import type { TypedEventBus } from './event-bus.js';
import { type ProviderHostManager, type ProviderServerAttachment } from './host-manager.js';
import { buildCoralInstruction } from './instruction.js';
import { LaunchOrchestrator, WaitCoordinator } from './job-lifecycle.js';
import {
  QUEUED_ABORT_MESSAGE,
  SessionClaimError,
  WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS,
  rejectLaunch,
  toProviderRequest,
  type AcceptedAdmission,
  type ClaimJobOptions,
} from './job-lifecycle-contracts.js';
import type { ProgressStore } from './progress-store.js';
import {
  parseAgentRef,
  resolveAgent,
  stripAgentMetadata,
  parseAgentMeta,
  InvalidAgentRefError,
  AgentNotFoundError,
  AgentNamespaceNotFoundError,
  type AgentResolutionContext,
} from './agent-resolution.js';
import { SessionManager, getSessionById, type SessionAllocateOptions } from './session-manager.js';
import type { Runtime } from './runtime.js';

interface LaunchIntentBase {
  prompt: string;
  name?: string;
  model?: string;
  cwd?: string;
  /** Set only by coralDispatch (agent metadata). */
  effort?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  instruction?: ProviderInstruction;
  /** Parent workflow job ID for atom launches. */
  parentWorkflowJobId?: string;
}

type ExecIntent = LaunchIntentBase & { agent?: string; pool?: LaunchPool };
type ResumeIntent = LaunchIntentBase & { sessionId: string; agent?: string; pool?: LaunchPool };
type ForkIntent = Omit<LaunchIntentBase, 'prompt'> & { sessionId: string; prompt?: string };
type CoralIntent = Omit<LaunchIntentBase, 'effort'> & { sessionId?: string; effort?: EffortLevel };

interface ListResult {
  sessions: SessionEntry[];
}

const FINALIZE_CONTINUITY_MAX_RETRIES = 2;

type ResolvedAgentLaunchProfile = {
  agentName: string;
  name: string;
  model?: string;
  instruction: ProviderInstruction;
};
type EffectiveContinuationProfile = {
  model?: string;
  cwd: string;
  effort: EffortLevel;
  bypassPermissions: boolean;
  systemPrompt?: string;
  instruction?: ProviderInstruction;
  controllerProfile?: SessionAllocateOptions['controllerProfile'];
  coralEnv: Record<string, string>;
  agentName?: string;
};

type InterruptedAppServerReason = 'restart' | 'handoff';
type InterruptedProbeOutcome = 'verified' | 'missing' | 'unavailable' | 'waiting';
type InterruptedAppServerFinalization = {
  conversationRef?: string;
  nonResumable?: boolean;
  continuityMutation?: ProviderContinuityBlob;
};

const APP_SERVER_RECOVERY_POLICY = 'session_continuity_only' as const;
const APP_SERVER_RESTART_NOTICE =
  'Backend restarted during the app-server turn. The interrupted turn was not replayed.';
const APP_SERVER_HANDOFF_NOTICE =
  'Backend handoff interrupted the app-server turn. The interrupted turn was not replayed.';
const APP_SERVER_INTERRUPTED_BEFORE_CONTINUITY_NOTICE =
  'The job ended before a resumable conversation checkpoint for this turn was written.';
const APP_SERVER_CONTINUITY_VERIFIED_NOTICE = 'Session continuity was verified for the saved conversation reference.';
const APP_SERVER_CONTINUITY_MISSING_NOTICE =
  'The saved conversation reference is no longer available, so the session is non-resumable.';
const APP_SERVER_CONTINUITY_UNVERIFIED_NOTICE =
  'Session continuity could not be verified because the recovery probe was unavailable.';

function joinNotice(...parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ');
}

function buildSessionControllerProfile(
  coralEnv: Record<string, string>,
): SessionAllocateOptions['controllerProfile'] | undefined {
  const owner = coralEnv.CORAL_OWNER;
  const effort = coralEnv.CORAL_EFFORT;
  const claudeModelCap = coralEnv.CORAL_CLAUDE_MODEL_CAP;

  if (owner === undefined && effort === undefined && claudeModelCap === undefined) {
    return undefined;
  }

  return {
    ...(owner !== undefined ? { owner } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(claudeModelCap !== undefined ? { claudeModelCap } : {}),
  };
}

function mapResolverError(err: unknown): LaunchDecision | null {
  if (err instanceof InvalidAgentRefError) return rejectLaunch('invalid_agent', err.message);
  if (err instanceof AgentNotFoundError) return rejectLaunch('agent_not_found', err.message);
  if (err instanceof AgentNamespaceNotFoundError) return rejectLaunch('agent_namespace_not_found', err.message);
  return null;
}

function resolveAgentLaunchProfile(
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

function buildEffectiveCoralEnv(
  coralEnv: Record<string, string>,
  options: {
    effort?: string;
    controllerProfile?: SessionAllocateOptions['controllerProfile'];
  } = {},
): Record<string, string> {
  const merged = { ...coralEnv };
  const storedProfile = options.controllerProfile;

  if (storedProfile?.owner !== undefined && merged.CORAL_OWNER === undefined) {
    merged.CORAL_OWNER = storedProfile.owner;
  }
  if (storedProfile?.claudeModelCap !== undefined && merged.CORAL_CLAUDE_MODEL_CAP === undefined) {
    merged.CORAL_CLAUDE_MODEL_CAP = storedProfile.claudeModelCap;
  }
  if (options.effort !== undefined) {
    merged.CORAL_EFFORT = options.effort;
  } else if (storedProfile?.effort !== undefined && merged.CORAL_EFFORT === undefined) {
    merged.CORAL_EFFORT = storedProfile.effort;
  }

  return merged;
}

function buildInterruptedAppServerReport(options: {
  baseNotice: string;
  probeOutcome: InterruptedProbeOutcome;
  conversationRef?: string;
}): string {
  const lines = [options.baseNotice, ''];

  if (options.probeOutcome === 'verified') {
    lines.push('Session is resumable. Use resume to continue.');
    if (options.conversationRef) {
      lines.push(`Conversation reference preserved: ${options.conversationRef}`);
    }
    return lines.join('\n');
  }

  if (options.probeOutcome === 'missing') {
    lines.push('Session thread is no longer available. Marked as non-resumable.');
    return lines.join('\n');
  }

  if (options.probeOutcome === 'unavailable') {
    lines.push('Could not reach provider server to verify session. Marked as non-resumable.');
    return lines.join('\n');
  }

  lines.push('Session was interrupted before completion. State unknown.');
  return lines.join('\n');
}

export type ExecutionServiceDeps = {
  runtime: Runtime;
  progressStore: ProgressStore;
  bundleHash?: string;
  backendNamespace: string;
  providerHostManager: ProviderHostManager;
  launchCoordinator: LaunchCoordinator;
  eventBus: TypedEventBus;
  providerRegistry: ProviderRegistry;
  pluginRegistry: {
    discoverPluginRoot: (namespace: string) => string | null;
  };
};

function isProviderContinuityBlob(value: unknown): value is ProviderContinuityBlob {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function serializeWorkflowResult(details: StepDetail[]): {
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

async function runProviderPreflight(provider: Provider): Promise<string | null> {
  if (!provider.preflight) return null;
  try {
    await provider.preflight();
    return null;
  } catch (error: unknown) {
    return errorMessage(error);
  }
}

/** Recovery-oriented interface for lifecycle startup/handoff/restart. */
export interface RecoveryCapableService {
  finalizeInterruptedAppServerJob(
    launchRecord: PersistedLaunchRecord,
    runtimeRecord: AppServerRuntimeRecord,
    context: { reason: 'restart' | 'handoff' },
  ): Promise<void>;
  adoptRunningJob(launchRecord: PersistedLaunchRecord, runtimeRecord: PersistedRuntimeRecord): { cleanup: () => void };
  recoverQueuedJob(launchRecord: PersistedLaunchRecord): string;
  interruptAppServerJob(launchRecord: PersistedLaunchRecord, runtimeRecord: AppServerRuntimeRecord): Promise<void>;
  completeRecoveredJob(
    jobId: string,
    sessionId: string,
    result: TerminalResult,
    phase: JobPhase,
    options?: { conversationRef?: string; nonResumable?: boolean },
  ): void;
}

export class ExecutionService implements RecoveryCapableService {
  private readonly runtime: Runtime;
  private readonly sessionManager: SessionManager;
  private readonly abortRegistry: AbortRegistry;
  private readonly backendNamespace: string;
  private readonly bundleHash: string;
  private readonly progressStore: ProgressStore;
  private readonly projectRoot: string;
  private readonly jobPools = new Map<string, LaunchPool>();
  private readonly providerHostManager: ProviderHostManager;
  private readonly launchCoordinator: LaunchCoordinator;
  private readonly eventBus: TypedEventBus;
  private readonly providerRegistry: ProviderRegistry;
  private readonly pluginRegistry: ExecutionServiceDeps['pluginRegistry'];
  private readonly launchOrchestrator: LaunchOrchestrator;
  private readonly waitCoordinator: WaitCoordinator;

  constructor(ctx: CallerContext, deps: ExecutionServiceDeps) {
    this.projectRoot = ctx.projectRoot;
    this.runtime = deps.runtime;
    this.eventBus = deps.eventBus;
    this.sessionManager = new SessionManager(ctx.projectRoot, deps.runtime, this.eventBus);
    this.abortRegistry = new AbortRegistry(deps.runtime.ids);
    this.backendNamespace = deps.backendNamespace;
    this.bundleHash = deps.bundleHash ?? 'unknown';
    this.progressStore = deps.progressStore;
    this.providerHostManager = deps.providerHostManager;
    this.launchCoordinator = deps.launchCoordinator;
    this.providerRegistry = deps.providerRegistry;
    this.pluginRegistry = deps.pluginRegistry;
    this.launchOrchestrator = new LaunchOrchestrator({
      abortRegistry: this.abortRegistry,
      progressStore: this.progressStore,
      sessionManager: this.sessionManager,
      launchCoordinator: this.launchCoordinator,
      runtime: this.runtime,
      backendNamespace: this.backendNamespace,
      bundleHash: this.bundleHash,
      jobPools: this.jobPools,
      acquireServer: (spec, options) => this.acquireServer(spec, options),
      checkpointRecovery: (jobId, update) => this.checkpointRecovery(jobId, update),
      finalizeProviderSession: (providerName, request, sessionId, jobId, result) =>
        this.finalizeProviderSession(providerName, request, sessionId, jobId, result),
    });
    this.waitCoordinator = new WaitCoordinator({
      progressStore: this.progressStore,
      sessionManager: this.sessionManager,
      launchCoordinator: this.launchCoordinator,
      eventBus: this.eventBus,
      jobPools: this.jobPools,
      time: this.runtime.time,
    });
  }

  async acquireServer(
    spec: ProviderServerSpec,
    options?: { jobId?: string; signal?: AbortSignal },
  ): Promise<ProviderServerLease> {
    if (options?.jobId) {
      this.writeAppServerRuntimeRecord(options.jobId, spec.provider, { leaseState: 'waiting' });
    }

    const lease = await this.providerHostManager.acquireServer(spec, { signal: options?.signal });
    if (options?.jobId) {
      this.writeAppServerRuntimeRecord(options.jobId, spec.provider, {
        leaseState: 'acquired',
        serverGeneration: lease.generation,
      });
    }
    return lease;
  }

  checkpointRecovery(jobId: string, update: { conversationRef?: string; providerMeta: ProviderRecoveryMeta }): void {
    const runtimeRecord = this.progressStore.readRuntimeRecord(jobId);
    if (!isAppServerRuntime(runtimeRecord)) {
      throw new Error(`checkpointRecovery(${jobId}) requires an app-server runtime record`);
    }
    const providerMetaUpdate = update.providerMeta as Partial<AppServerRuntimeRecord['providerMeta']>;

    const nextRecord: AppServerRuntimeRecord = {
      ...runtimeRecord,
      providerMeta: {
        ...runtimeRecord.providerMeta,
        ...providerMetaUpdate,
        recoveryPolicy: APP_SERVER_RECOVERY_POLICY,
      },
    };
    this.progressStore.writeRuntimeRecord(jobId, nextRecord);

    const status = this.progressStore.readStatus(jobId);
    if (status && isProviderContinuityBlob(nextRecord.providerMeta.providerContinuity)) {
      this.sessionManager.checkpointProviderContinuity(status.sessionId, {
        providerContinuity: nextRecord.providerMeta.providerContinuity,
        conversationRef: update.conversationRef,
      });
      return;
    }

    if (status && update.conversationRef) {
      this.sessionManager.setConversationRef(status.sessionId, update.conversationRef);
    }
  }

  async interruptAppServerJob(
    launchRecord: PersistedLaunchRecord,
    runtimeRecord: AppServerRuntimeRecord,
  ): Promise<void> {
    const provider = this.providerRegistry.get(launchRecord.provider);
    if (!provider?.appServer) {
      return;
    }
    const session = this.sessionManager.get(launchRecord.provider, launchRecord.sessionId);
    const continuity = this.resolveAppServerContinuity(launchRecord.provider, runtimeRecord, session);
    if (!continuity) {
      return;
    }

    const spec = provider.appServer.buildServerSpec(continuity, toProviderRequest(launchRecord));
    if (spec.shared !== true) {
      const liveServer = await this.providerHostManager.borrowLiveServer(spec, {
        serverGeneration: runtimeRecord.providerMeta.serverGeneration,
      });
      if (liveServer) {
        await provider.appServer.interrupt(this.createAttachedProviderServerLease(liveServer), continuity);
        return;
      }
    }

    const lease = await this.acquireServer(spec);
    try {
      await provider.appServer.interrupt(lease, continuity);
    } finally {
      lease.release();
    }
  }

  async finalizeInterruptedAppServerJob(
    launchRecord: PersistedLaunchRecord,
    runtimeRecord: AppServerRuntimeRecord,
    options: { reason: InterruptedAppServerReason },
  ): Promise<void> {
    const status = this.progressStore.readStatus(launchRecord.jobId);
    if (!status || isTerminalPhase(status.phase)) {
      return;
    }

    const baseNotice = options.reason === 'restart' ? APP_SERVER_RESTART_NOTICE : APP_SERVER_HANDOFF_NOTICE;
    const provider = this.providerRegistry.get(launchRecord.provider);
    const session =
      this.sessionManager.get(launchRecord.provider, launchRecord.sessionId) ??
      ({
        conversationRef: launchRecord.request.conversationRef,
      } as Pick<SessionEntry, 'conversationRef' | 'providerContinuity'>);
    const preservedConversationRef = session.conversationRef ?? launchRecord.request.conversationRef;
    const continuity = this.resolveAppServerContinuity(launchRecord.provider, runtimeRecord, session);

    const toMutation = (finalization: InterruptedAppServerFinalization) => {
      if (finalization.nonResumable) {
        return {
          type: 'clear_non_resumable',
          ...(finalization.continuityMutation ? { providerContinuity: finalization.continuityMutation } : {}),
        } as const;
      }

      const conversationRef = finalization.conversationRef ?? preservedConversationRef;
      if (conversationRef) {
        return {
          type: 'set_resumable',
          conversationRef,
          ...(finalization.continuityMutation ? { providerContinuity: finalization.continuityMutation } : {}),
        } as const;
      }

      return {
        type: 'preserve',
        ...(finalization.continuityMutation ? { providerContinuity: finalization.continuityMutation } : {}),
      } as const;
    };

    let mutation:
      | { type: 'set_resumable'; conversationRef: string; providerContinuity?: ProviderContinuityBlob }
      | { type: 'clear_non_resumable'; providerContinuity?: ProviderContinuityBlob }
      | { type: 'preserve'; providerContinuity?: ProviderContinuityBlob };
    let probeOutcome: InterruptedProbeOutcome;

    if (provider?.appServer && continuity) {
      if (runtimeRecord.providerMeta.leaseState === 'waiting') {
        probeOutcome = 'waiting';
        mutation = toMutation(
          provider.appServer.finalizeInterrupted(
            {
              resumable: Boolean(preservedConversationRef ?? continuity),
              updatedContinuity: continuity,
            },
            continuity,
          ),
        );
      } else {
        const spec = provider.appServer.buildServerSpec(continuity, toProviderRequest(launchRecord));

        try {
          const liveServer =
            spec.shared !== true && runtimeRecord.providerMeta.leaseState === 'acquired'
              ? await this.providerHostManager.borrowLiveServer(spec, {
                  serverGeneration: runtimeRecord.providerMeta.serverGeneration,
                })
              : null;
          const lease = liveServer
            ? this.createAttachedProviderServerLease(liveServer)
            : await this.acquireServer(spec);
          try {
            const probeResult = await provider.appServer.probe(lease, continuity);
            probeOutcome = probeResult.resumable ? 'verified' : 'missing';
            mutation = toMutation(provider.appServer.finalizeInterrupted(probeResult, continuity));
          } finally {
            if (!liveServer) {
              lease.release();
            }
          }
        } catch (error: unknown) {
          backendLog.error(
            `Probe failed for ${launchRecord.jobId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          probeOutcome = 'unavailable';
          mutation = toMutation(
            provider.appServer.finalizeInterrupted(
              {
                resumable: false,
                updatedContinuity: continuity,
              },
              continuity,
            ),
          );
        }
      }
    } else if (preservedConversationRef) {
      probeOutcome = 'waiting';
      mutation = {
        type: 'set_resumable',
        conversationRef: preservedConversationRef,
      };
    } else {
      probeOutcome = 'waiting';
      mutation = { type: 'clear_non_resumable' };
    }

    let notice: string;
    if (probeOutcome === 'waiting') {
      notice = joinNotice(
        baseNotice,
        APP_SERVER_INTERRUPTED_BEFORE_CONTINUITY_NOTICE,
        mutation.type === 'clear_non_resumable'
          ? 'No resumable conversation was available.'
          : 'The existing conversation reference was preserved.',
      );
    } else if (probeOutcome === 'verified') {
      notice = joinNotice(baseNotice, APP_SERVER_CONTINUITY_VERIFIED_NOTICE);
    } else if (probeOutcome === 'missing') {
      notice = joinNotice(baseNotice, APP_SERVER_CONTINUITY_MISSING_NOTICE);
    } else {
      notice = joinNotice(baseNotice, APP_SERVER_CONTINUITY_UNVERIFIED_NOTICE);
    }

    let reportConversationRef: string | undefined;
    if (probeOutcome === 'verified') {
      reportConversationRef = mutation.type === 'set_resumable' ? mutation.conversationRef : preservedConversationRef;
    }

    const interruptedReport = buildInterruptedAppServerReport({
      baseNotice,
      probeOutcome,
      conversationRef: reportConversationRef,
    });

    this.progressStore.updateLaunchState(launchRecord.jobId, 'error', notice);
    this.writeTerminalResult(
      launchRecord.jobId,
      launchRecord.sessionId,
      {
        content: interruptedReport,
        notice,
        ...(probeOutcome === 'missing' || probeOutcome === 'unavailable' ? { nonResumable: true } : {}),
      },
      'error',
    );
    this.progressStore.writeResultMd(launchRecord.jobId, interruptedReport);
    this.abortRegistry.remove(launchRecord.jobId);
    this.launchCoordinator.releaseLaunch(
      launchRecord.jobId,
      (this.jobPools.get(launchRecord.jobId) ?? launchRecord.pool ?? 'default') as LaunchPool,
    );
    this.jobPools.delete(launchRecord.jobId);
    await this.finalizeSessionContinuityMutation(
      launchRecord.provider,
      launchRecord.sessionId,
      launchRecord.jobId,
      mutation,
    );
  }

  private async claimJobAtomic(
    session: SessionEntry,
    jobId: string,
    providerName: string,
    projectRoot: string,
    options: ClaimJobOptions = {},
  ): Promise<SessionEntry> {
    this.progressStore.initJob({
      jobId,
      sessionId: session.sessionId,
      provider: providerName,
      projectRoot,
      backendNamespace: this.backendNamespace,
      bundleHash: this.bundleHash,
      jobKind: options.jobKind,
      initialPhase: options.initialPhase ?? 'launching',
    });

    try {
      const claimed = await this.sessionManager.claimForJobAtomic(
        session.sessionId,
        jobId,
        options.expectedVersion ?? session.version,
      );
      if (!claimed) {
        throw new SessionClaimError();
      }
      return session;
    } catch (error: unknown) {
      this.progressStore.rollbackJob(jobId);
      throw error;
    }
  }

  private createAttachedProviderServerLease(attachment: ProviderServerAttachment): ProviderServerLease {
    return {
      rpc: attachment.rpc,
      subscribe: attachment.subscribe,
      release: () => {},
      closed: attachment.closed,
    };
  }

  private resolveAppServerContinuity(
    providerName: string,
    runtimeRecord: AppServerRuntimeRecord,
    session?: Pick<SessionEntry, 'providerContinuity'> | null,
  ): ProviderContinuityBlob | undefined {
    if (isProviderContinuityBlob(runtimeRecord.providerMeta.providerContinuity)) {
      return runtimeRecord.providerMeta.providerContinuity;
    }
    if (isProviderContinuityBlob(session?.providerContinuity)) {
      return session.providerContinuity;
    }

    const provider = this.providerRegistry.get(providerName);
    return provider?.appServer?.migrateLegacyContinuity?.(runtimeRecord.providerMeta as Record<string, unknown>);
  }

  private writeAppServerRuntimeRecord(
    jobId: string,
    providerName: string,
    update: Partial<AppServerRuntimeRecord['providerMeta']>,
  ): void {
    const current = this.progressStore.readRuntimeRecord(jobId);
    const appRuntime = isAppServerRuntime(current) ? current : null;
    const record: AppServerRuntimeRecord = {
      transport: 'app-server',
      startTime: appRuntime?.startTime ?? nowIsoString(this.runtime.time),
      providerMeta: {
        provider: providerName,
        leaseState: update.leaseState ?? appRuntime?.providerMeta.leaseState ?? 'waiting',
        serverGeneration: update.serverGeneration ?? appRuntime?.providerMeta.serverGeneration,
        providerContinuity: update.providerContinuity ?? appRuntime?.providerMeta.providerContinuity,
        recoveryPolicy: APP_SERVER_RECOVERY_POLICY,
      },
    };
    this.progressStore.writeRuntimeRecord(jobId, record);
  }

  private resolveSessionByIdForContinuation(
    sessionId: string,
    ctx: CallerContext,
  ): { providerName: string; session: SessionEntry } | LaunchDecision {
    const session = getSessionById(sessionId, this.runtime, this.eventBus);
    if (!session) {
      return rejectLaunch('session_not_found', `Session not found: ${sessionId}. Use exec to start a new session.`);
    }
    if (session.backendNamespace === undefined || session.projectRoot === undefined) {
      return rejectLaunch(
        'legacy_session_unsupported',
        `Session ${sessionId} is missing stored backend scope metadata and cannot be continued by session id.`,
      );
    }
    if (session.backendNamespace !== this.backendNamespace || session.projectRoot !== ctx.projectRoot) {
      return rejectLaunch(
        'scope_mismatch',
        `Session ${sessionId} does not belong to this backend namespace and project scope.`,
      );
    }

    return {
      providerName: session.provider,
      session,
    };
  }

  private buildContinuationProfile(
    input: Pick<ResumeIntent | ForkIntent, 'model' | 'cwd' | 'effort' | 'bypassPermissions' | 'systemPrompt' | 'instruction'>,
    session: SessionEntry,
    ctx: CallerContext,
  ): EffectiveContinuationProfile {
    const coralEnv = buildEffectiveCoralEnv(ctx.coralEnv, {
      effort: input.effort,
      controllerProfile: session.controllerProfile,
    });

    return {
      model: input.model ?? session.model,
      cwd: input.cwd ?? session.cwd,
      effort: resolveEffort(input.effort, coralEnv),
      bypassPermissions: input.bypassPermissions ?? session.bypassPermissions ?? false,
      systemPrompt: input.systemPrompt ?? session.systemPrompt,
      instruction: input.instruction ?? session.instruction,
      controllerProfile: buildSessionControllerProfile(coralEnv),
      coralEnv,
      agentName: session.agentName,
    };
  }

  private async resumeResolved(
    providerName: string,
    provider: Provider,
    session: SessionEntry,
    input: ResumeIntent,
    ctx: CallerContext,
  ): Promise<LaunchDecision> {
    const busyMessage = `Session ${input.sessionId} already has an active job. Wait for it to complete or abort it first.`;
    if (session.state === 'non_resumable') {
      return rejectLaunch(
        'non_resumable',
        `Session ${input.sessionId} is non-resumable. Use exec to start a new session or fork to branch from it.`,
      );
    }
    if (session.activeJobId) {
      return rejectLaunch('session_busy', busyMessage);
    }
    const expectedVersion = session.version;
    const pool = input.pool ?? 'default';

    const preflightError = await runProviderPreflight(provider);
    if (preflightError) return rejectLaunch('preflight_failed', preflightError);

    const admitted = await this.claimAndAdmitJob(
      session,
      providerName,
      ctx.projectRoot,
      busyMessage,
      expectedVersion,
      pool,
    );
    if ('status' in admitted) return admitted;

    const continuation = this.buildContinuationProfile(input, session, ctx);
    const request: ProviderRequest = {
      action: 'resume',
      sessionId: session.sessionId,
      prompt: input.prompt,
      conversationRef: session.conversationRef,
      model: continuation.model,
      cwd: continuation.cwd,
      effort: continuation.effort,
      bypassPermissions: continuation.bypassPermissions,
      systemPrompt: continuation.systemPrompt,
      instruction: continuation.instruction,
      coralEnv: continuation.coralEnv,
    };

    return this.launchProviderJob(provider, session.sessionId, admitted.jobId, request, admitted.admission, {
      pool,
      projectRoot: ctx.projectRoot,
      parentWorkflowJobId: input.parentWorkflowJobId,
    });
  }

  private async forkResolved(
    providerName: string,
    provider: Provider,
    sourceSession: SessionEntry,
    input: ForkIntent,
    ctx: CallerContext,
  ): Promise<LaunchDecision> {
    const sourceBusyMessage = `Session ${input.sessionId} already has an active job. Wait for it to complete or abort it first.`;
    if (sourceSession.activeJobId) {
      return rejectLaunch('session_busy', sourceBusyMessage);
    }
    const sourceExpectedVersion = sourceSession.version;

    const preflightError = await runProviderPreflight(provider);
    if (preflightError) return rejectLaunch('preflight_failed', preflightError);

    const sourceClaimId = this.runtime.ids.uuid();
    const sourceClaimed = await this.sessionManager.claimForJobAtomic(
      sourceSession.sessionId,
      sourceClaimId,
      sourceExpectedVersion,
    );
    if (!sourceClaimed) {
      return rejectLaunch('session_busy', sourceBusyMessage);
    }

    try {
      const name = input.name ?? `fork-${this.runtime.time.now()}`;
      const continuation = this.buildContinuationProfile(input, sourceSession, ctx);
      const newSession = this.sessionManager.allocate({
        provider: providerName,
        name,
        model: continuation.model,
        cwd: continuation.cwd,
        projectRoot: ctx.projectRoot,
        backendNamespace: this.backendNamespace,
        ...(continuation.agentName !== undefined ? { agentName: continuation.agentName } : {}),
        ...(continuation.instruction !== undefined ? { instruction: continuation.instruction } : {}),
        bypassPermissions: continuation.bypassPermissions,
        ...(continuation.systemPrompt !== undefined ? { systemPrompt: continuation.systemPrompt } : {}),
        ...(continuation.controllerProfile !== undefined ? { controllerProfile: continuation.controllerProfile } : {}),
      });
      const admitted = await this.claimAndAdmitJob(
        newSession,
        providerName,
        ctx.projectRoot,
        'New fork session already has an active job',
        newSession.version,
      );
      if ('status' in admitted) return admitted;

      const request: ProviderRequest = {
        action: 'fork',
        sessionId: newSession.sessionId,
        name: input.name,
        prompt: input.prompt ?? '',
        conversationRef: sourceSession.conversationRef,
        model: continuation.model,
        cwd: continuation.cwd,
        effort: continuation.effort,
        bypassPermissions: continuation.bypassPermissions,
        systemPrompt: continuation.systemPrompt,
        instruction: continuation.instruction,
        coralEnv: continuation.coralEnv,
      };

      return this.launchProviderJob(provider, newSession.sessionId, admitted.jobId, request, admitted.admission, {
        projectRoot: ctx.projectRoot,
      });
    } finally {
      this.sessionManager.releaseJob(sourceSession.sessionId, sourceClaimId);
    }
  }

  private async claimAndAdmitJob(
    session: SessionEntry,
    providerName: string,
    projectRoot: string,
    sessionBusyMessage: string,
    expectedVersion: number = session.version,
    pool: LaunchPool = 'default',
  ): Promise<{ jobId: string; admission: AcceptedAdmission } | LaunchDecision> {
    return this.launchOrchestrator.claimAndAdmitJob(
      session,
      providerName,
      projectRoot,
      sessionBusyMessage,
      (claimSession, jobId, claimProviderName, claimProjectRoot, options) =>
        this.claimJobAtomic(claimSession, jobId, claimProviderName, claimProjectRoot, options),
      expectedVersion,
      pool,
    );
  }

  private launchProviderJob(
    provider: Provider,
    sessionId: string,
    jobId: string,
    request: ProviderRequest,
    admission: AcceptedAdmission,
    opts: { pool?: LaunchPool; projectRoot?: string; parentWorkflowJobId?: string } = {},
  ): LaunchDecision {
    return this.launchOrchestrator.launchProviderJob(provider, sessionId, jobId, request, admission, opts);
  }

  async start(providerName: string, input: ExecIntent, ctx: CallerContext): Promise<LaunchDecision> {
    const provider = this.providerRegistry.get(providerName);
    if (!provider) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

    const preflightError = await runProviderPreflight(provider);
    if (preflightError) return rejectLaunch('preflight_failed', preflightError);

    let resolvedAgent: ResolvedAgentLaunchProfile | null = null;
    if (input.agent) {
      try {
        resolvedAgent = resolveAgentLaunchProfile(input.agent, {
          projectRoot: ctx.projectRoot,
          coralPluginRoot: ctx.pluginRoot,
          discoverPluginRoot: this.pluginRegistry.discoverPluginRoot.bind(this.pluginRegistry),
          storage: this.runtime.storage,
        });
      } catch (err) {
        const rejection = mapResolverError(err);
        if (rejection) return rejection;
        throw err;
      }
    }
    const effectiveCoralEnv = buildEffectiveCoralEnv(ctx.coralEnv, { effort: input.effort });
    const cwd = input.cwd ?? ctx.projectRoot;
    const requestName = resolvedAgent?.name ?? input.name;
    const name = requestName ?? `session-${this.runtime.time.now()}`;
    const model = input.model ?? resolvedAgent?.model;
    const pool = input.pool ?? 'default';
    const controllerProfile = buildSessionControllerProfile(effectiveCoralEnv);
    const instruction = resolvedAgent?.instruction ?? input.instruction;
    const bypassPermissions = input.bypassPermissions ?? (resolvedAgent !== null);

    const session = this.sessionManager.allocate({
      provider: providerName,
      name,
      model,
      cwd,
      projectRoot: ctx.projectRoot,
      backendNamespace: this.backendNamespace,
      ...(resolvedAgent !== null ? { agentName: resolvedAgent.agentName } : {}),
      ...(instruction !== undefined ? { instruction } : {}),
      bypassPermissions,
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      ...(controllerProfile !== undefined ? { controllerProfile } : {}),
    });
    const admitted = await this.claimAndAdmitJob(
      session,
      providerName,
      ctx.projectRoot,
      'Session is already running a job',
      session.version,
      pool,
    );
    if ('status' in admitted) return admitted;

    const request: ProviderRequest = {
      action: 'exec',
      sessionId: session.sessionId,
      name: requestName,
      prompt: input.prompt,
      model,
      cwd,
      effort: resolveEffort(input.effort, effectiveCoralEnv),
      bypassPermissions,
      systemPrompt: input.systemPrompt,
      instruction,
      coralEnv: effectiveCoralEnv,
    };

    return this.launchProviderJob(provider, session.sessionId, admitted.jobId, request, admitted.admission, {
      pool,
      projectRoot: ctx.projectRoot,
      parentWorkflowJobId: input.parentWorkflowJobId,
    });
  }

  async resume(providerName: string, input: ResumeIntent, ctx: CallerContext): Promise<LaunchDecision> {
    const provider = this.providerRegistry.get(providerName);
    if (!provider) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

    const session = this.sessionManager.get(providerName, input.sessionId);
    if (!session)
      return rejectLaunch(
        'session_not_found',
        `Session not found: ${input.sessionId}. Use exec to start a new session.`,
      );

    // Resolve agent profile before continuation so instruction/model are available
    let effectiveInput = input;
    if (input.agent) {
      let resolvedAgent: ResolvedAgentLaunchProfile;
      try {
        resolvedAgent = resolveAgentLaunchProfile(input.agent, {
          projectRoot: ctx.projectRoot,
          coralPluginRoot: ctx.pluginRoot,
          discoverPluginRoot: this.pluginRegistry.discoverPluginRoot.bind(this.pluginRegistry),
          storage: this.runtime.storage,
        });
      } catch (err) {
        const rejection = mapResolverError(err);
        if (rejection) return rejection;
        throw err;
      }
      effectiveInput = {
        ...input,
        name: resolvedAgent.name,
        model: input.model ?? resolvedAgent.model,
        instruction: input.instruction ?? resolvedAgent.instruction,
      };
    }

    return this.resumeResolved(providerName, provider, session, effectiveInput, ctx);
  }

  async fork(providerName: string, input: ForkIntent, ctx: CallerContext): Promise<LaunchDecision> {
    const provider = this.providerRegistry.get(providerName);
    if (!provider) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

    const sourceSession = this.sessionManager.get(providerName, input.sessionId);
    if (!sourceSession)
      return rejectLaunch(
        'session_not_found',
        `Session not found: ${input.sessionId}. Use exec to start a new session.`,
      );
    return this.forkResolved(providerName, provider, sourceSession, input, ctx);
  }

  async resumeBySessionId(input: ResumeIntent, ctx: CallerContext): Promise<LaunchDecision> {
    const resolved = this.resolveSessionByIdForContinuation(input.sessionId, ctx);
    if ('status' in resolved) return resolved;

    const provider = this.providerRegistry.get(resolved.providerName);
    if (!provider) return rejectLaunch('unknown_provider', `Unknown provider: ${resolved.providerName}`);

    return this.resumeResolved(resolved.providerName, provider, resolved.session, input, ctx);
  }

  async forkBySessionId(input: ForkIntent, ctx: CallerContext): Promise<LaunchDecision> {
    const resolved = this.resolveSessionByIdForContinuation(input.sessionId, ctx);
    if ('status' in resolved) return resolved;

    const provider = this.providerRegistry.get(resolved.providerName);
    if (!provider) return rejectLaunch('unknown_provider', `Unknown provider: ${resolved.providerName}`);

    return this.forkResolved(resolved.providerName, provider, resolved.session, input, ctx);
  }

  async coralDispatch(
    providerName: string,
    coralName: string,
    input: CoralIntent,
    ctx: CallerContext,
  ): Promise<LaunchDecision> {
    // CRITICAL: force the coral namespace to preserve workflow atom identity
    // against project overrides when internal coral workflows dispatch agents.
    const forcedIdent = coralName.startsWith('coral:') ? coralName : `coral:${coralName}`;
    const bypassPermissions = input.bypassPermissions ?? true;

    if (input.sessionId) {
      return this.resume(
        providerName,
        {
          sessionId: input.sessionId,
          prompt: input.prompt,
          agent: forcedIdent,
          cwd: input.cwd,
          effort: input.effort,
          bypassPermissions,
          systemPrompt: input.systemPrompt,
          parentWorkflowJobId: input.parentWorkflowJobId,
        },
        ctx,
      );
    }

    return this.start(
      providerName,
      {
        prompt: input.prompt,
        agent: forcedIdent,
        cwd: input.cwd,
        effort: input.effort,
        bypassPermissions,
        systemPrompt: input.systemPrompt,
        parentWorkflowJobId: input.parentWorkflowJobId,
      },
      ctx,
    );
  }

  async executeWorkflow(
    providerName: string,
    ast: PipelineAST,
    input: WorkflowCommand,
    ctx: CallerContext,
    workDir?: string,
  ): Promise<LaunchDecision> {
    if (!this.providerRegistry.get(providerName)) {
      return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);
    }

    const controllerProfile = buildSessionControllerProfile(ctx.coralEnv);
    const session = this.sessionManager.allocate({
      provider: providerName,
      name: `workflow-${this.runtime.time.now()}`,
      model: 'workflow',
      cwd: ctx.projectRoot,
      projectRoot: ctx.projectRoot,
      backendNamespace: this.backendNamespace,
      ...(controllerProfile !== undefined ? { controllerProfile } : {}),
    });
    // Workflow jobs bypass the admission queue: the workflow coordinator itself
    // does not occupy a child-process slot — only the individual atoms it launches do.
    const jobId = this.abortRegistry.register();

    try {
      await this.claimJobAtomic(session, jobId, providerName, ctx.projectRoot, {
        expectedVersion: session.version,
        jobKind: 'workflow',
      });
    } catch (error: unknown) {
      this.abortRegistry.remove(jobId);
      if (error instanceof SessionClaimError) {
        return rejectLaunch('session_busy', 'Session is already running a job');
      }
      throw error;
    }

    this.markJobRunning(jobId);

    this.runWorkflowAsync(session.sessionId, jobId, providerName, ast, input, ctx, workDir);
    return { status: 'running', job: jobId, session: session.sessionId };
  }

  list(providerName: string): ListResult {
    return { sessions: this.sessionManager.list(providerName) };
  }

  getConversationRef(providerName: string, sessionId: string): string | undefined {
    return this.sessionManager.get(providerName, sessionId)?.conversationRef;
  }

  abort(jobIds: string[]): AbortResult {
    const aborted: string[] = [];
    const notFound: string[] = [];

    for (const jobId of jobIds) {
      if (!this.abortRegistry.has(jobId)) {
        notFound.push(jobId);
        continue;
      }

      const status = this.progressStore.readStatus(jobId);
      const pool = this.jobPools.get(jobId) ?? 'default';
      if (status?.phase === 'queued' && this.launchCoordinator.cancelQueued(jobId, pool)) {
        this.finishQueuedAbort(jobId, status.sessionId, QUEUED_ABORT_MESSAGE);
        aborted.push(jobId);
        continue;
      }

      const runtimeRecord = this.progressStore.readRuntimeRecord(jobId);
      const launchRecord = this.progressStore.readLaunchRecord(jobId);
      if (launchRecord && isAppServerRuntime(runtimeRecord)) {
        void this.interruptAppServerJob(launchRecord, runtimeRecord).catch((error: unknown) => {
          backendLog.error(`Failed to interrupt app-server job ${jobId}: ${errorMessage(error)}`);
        });
      }

      this.abortRegistry.abort([jobId]);
      aborted.push(jobId);
    }

    return { aborted, notFound };
  }

  async waitForJobTerminal(jobId: string, timeoutMs = WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS): Promise<void> {
    return this.waitCoordinator.waitForJobTerminal(jobId, timeoutMs);
  }

  // ── Recovery adoption APIs ──────────────────────────────────────────────────

  /**
   * Recover a queued job from a persisted launch record.
   * Restores pool mapping, hydrates the event counter, inserts into the queue
   * via `restoreQueuedLaunch` (FIFO order preserved by caller invocation order),
   * and wires up the async execution path for when the permit is granted.
   */
  recoverQueuedJob(launchRecord: PersistedLaunchRecord): string {
    const pool = (launchRecord.pool || 'default') as LaunchPool;
    const jobId = launchRecord.jobId;

    this.jobPools.set(jobId, pool);
    this.progressStore.hydrateEventCounter(jobId);

    // Restore queue entry and register abort with cancel callback
    const queuedHandle = this.launchCoordinator.restoreQueuedLaunch(jobId, launchRecord.provider, pool);
    this.abortRegistry.register(jobId, () => {
      queuedHandle.cancel();
    });

    // Rebind namespace to current backend instance
    this.progressStore.rebindNamespace(jobId, this.backendNamespace, this.bundleHash);

    // Wire up the async execution path
    const provider = this.providerRegistry.get(launchRecord.provider);
    if (provider) {
      this.launchOrchestrator.runRecoveredQueuedJob(provider, launchRecord, queuedHandle, pool);
    }

    return jobId;
  }

  /**
   * Adopt a running job that has a live PID from a previous backend instance.
   * Restores pool mapping, hydrates counters, restores the active launch permit,
   * rebinds namespace, and registers abort with a PID-kill callback.
   * Returns a cleanup handle for the PID poller to call when the job terminates.
   */
  adoptRunningJob(launchRecord: PersistedLaunchRecord, runtimeRecord: PersistedRuntimeRecord): { cleanup: () => void } {
    const pool = (launchRecord.pool || 'default') as LaunchPool;
    const jobId = launchRecord.jobId;

    // TODO(AC2-AC10): branch on runtime transport during startup recovery instead of assuming a durable PID.
    if (!isDurableCliRuntime(runtimeRecord)) {
      throw new Error(`Unsupported runtime transport for adoptRunningJob(${jobId}): ${runtimeRecord.transport}`);
    }

    this.jobPools.set(jobId, pool);
    this.progressStore.hydrateEventCounter(jobId);
    this.progressStore.hydrateJobStartedAt(jobId, runtimeRecord.startTime);

    // Restore active permit before fence lifts
    this.launchCoordinator.restoreActiveLaunch(jobId, launchRecord.provider, pool);

    // Rebind namespace to current backend instance
    this.progressStore.rebindNamespace(jobId, this.backendNamespace, this.bundleHash);

    // Register abort with PID-kill delegate
    const pid = runtimeRecord.pid;
    this.abortRegistry.register(jobId, () => {
      this.runtime.process.kill(pid, 'SIGTERM');
    });

    // Return cleanup handle for the PID poller
    let cleaned = false;
    return {
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        this.abortRegistry.remove(jobId);
        this.launchCoordinator.releaseLaunch(jobId, pool);
        this.jobPools.delete(jobId);
      },
    };
  }

  /**
   * Finalize a recovered job with a terminal result.
   * Writes the result, updates session state, releases the launch permit, and frees session/abort state.
   */
  completeRecoveredJob(
    jobId: string,
    sessionId: string,
    result: TerminalResult,
    phase: JobPhase,
    options?: { conversationRef?: string; nonResumable?: boolean },
  ): void {
    this.writeTerminalResult(jobId, sessionId, result, phase);
    this.progressStore.writeResultMd(jobId, result.content);
    this.abortRegistry.remove(jobId);
    const pool = this.jobPools.get(jobId) ?? 'default';
    this.launchCoordinator.releaseLaunch(jobId, pool);
    this.jobPools.delete(jobId);

    if (options?.conversationRef) {
      this.sessionManager.setConversationRef(sessionId, options.conversationRef);
    } else if (options?.nonResumable) {
      this.sessionManager.setNonResumable(sessionId);
    }
    this.sessionManager.releaseJob(sessionId, jobId);
  }

  private async finalizeSessionContinuityMutation(
    providerName: string,
    sessionId: string,
    jobId: string,
    mutation:
      | { type: 'set_resumable'; conversationRef: string; providerContinuity?: ProviderContinuityBlob }
      | { type: 'clear_non_resumable'; providerContinuity?: ProviderContinuityBlob }
      | { type: 'preserve'; providerContinuity?: ProviderContinuityBlob },
  ): Promise<boolean> {
    for (let attempt = 0; attempt < FINALIZE_CONTINUITY_MAX_RETRIES; attempt += 1) {
      const session = this.sessionManager.get(providerName, sessionId);
      if (!session || session.activeJobId !== jobId) {
        return false;
      }

      const finalized = await this.sessionManager.finalizeJobContinuityAtomic(sessionId, {
        expectedActiveJobId: jobId,
        expectedVersion: session.version,
        mutation,
      });
      if (finalized) {
        return true;
      }
    }

    // Retries exhausted — release claim as fallback to prevent session leak.
    // Mutation data (conversationRef, resumability) is lost but will be re-derived on next job.
    this.sessionManager.releaseJob(sessionId, jobId);
    return false;
  }

  private async finalizeProviderSession(
    providerName: string,
    request: ProviderRequest,
    sessionId: string,
    jobId: string,
    result: ProviderResult,
  ): Promise<void> {
    const provider = this.providerRegistry.get(providerName);
    const runtimeRecord = this.progressStore.readRuntimeRecord(jobId);
    if (provider?.appServer && isAppServerRuntime(runtimeRecord)) {
      const continuity = this.resolveAppServerContinuity(
        providerName,
        runtimeRecord,
        this.sessionManager.get(providerName, sessionId),
      );

      if (request.action === 'resume' && result.nonResumable && !continuity) {
        await this.finalizeSessionContinuityMutation(providerName, sessionId, jobId, {
          type: 'clear_non_resumable',
        });
        return;
      }

      if (result.conversationRef && !continuity) {
        await this.finalizeSessionContinuityMutation(providerName, sessionId, jobId, {
          type: 'set_resumable',
          conversationRef: result.conversationRef,
        });
        return;
      }

      await this.finalizeSessionContinuityMutation(providerName, sessionId, jobId, {
        type: 'preserve',
      });
      return;
    }

    if (request.action === 'resume' && result.nonResumable) {
      await this.finalizeSessionContinuityMutation(providerName, sessionId, jobId, {
        type: 'clear_non_resumable',
      });
      return;
    }

    if (result.conversationRef) {
      this.sessionManager.setConversationRef(sessionId, result.conversationRef);
    } else if (result.nonResumable) {
      this.sessionManager.setNonResumable(sessionId);
    }
    this.sessionManager.releaseJob(sessionId, jobId);
  }

  /**
   * Poll until launch state is non-pending. Returns 'pending' if timeout expires.
   * Returns 'queued' immediately for queued jobs — callers must NOT treat this as an error.
   * Use waitStream() to monitor actual completion after a 'queued' return.
   */
  async awaitLaunch(jobId: string, timeoutMs: number): Promise<LaunchState> {
    const start = this.runtime.time.now();
    while (true) {
      const seq = this.progressStore.getChangeSeq();
      const status = this.progressStore.readStatus(jobId);
      if (status && status.launch.state !== 'pending') return status.launch.state;

      const remainingMs = timeoutMs - (this.runtime.time.now() - start);
      if (remainingMs <= 0) return 'pending';
      await Promise.race([
        this.progressStore.waitForChange(seq),
        this.runtime.time.sleep(remainingMs),
      ]);
    }
  }

  /** Async generator yielding queued/progress/terminal/timeout events for monitored jobs. */
  async *waitStream(req: WaitRequest): AsyncGenerator<WaitStreamEvent> {
    yield* this.waitCoordinator.waitForJobs(req);
  }

  async waitStreamOnce(jobId: string, timeoutMs?: number): Promise<{ content: string; nonResumable: boolean }> {
    return this.waitCoordinator.waitStreamOnce(jobId, timeoutMs);
  }

  private finishQueuedAbort(jobId: string, sessionId: string, message: string): void {
    this.launchOrchestrator.finishQueuedAbort(jobId, sessionId, message);
  }

  private markJobRunning(jobId: string): void {
    this.launchOrchestrator.markJobRunning(jobId);
  }

  private finishWorkflowJob(
    sessionId: string,
    jobId: string,
    phase: Extract<JobPhase, 'completed' | 'error' | 'aborted'>,
    result: TerminalResult,
    markdown: string,
  ): void {
    this.progressStore.writeWorkflowResultMdOrThrow(jobId, markdown);
    this.writeTerminalResult(jobId, sessionId, result, phase);
    this.sessionManager.setNonResumable(sessionId);
    this.abortRegistry.remove(jobId);
    this.sessionManager.releaseJob(sessionId, jobId);
  }

  private writeTerminalResult(jobId: string, sessionId: string, result: TerminalResult, phase: JobPhase): void {
    this.launchOrchestrator.writeTerminalResult(jobId, sessionId, result, phase);
  }

  private runWorkflowAsync(
    sessionId: string,
    jobId: string,
    providerName: string,
    ast: PipelineAST,
    input: WorkflowCommand,
    ctx: CallerContext,
    workDir?: string,
  ): void {
    const signal = this.abortRegistry.getSignal(jobId);
    if (!signal) return;

    void executePipeline(ast, input.startPrompt, providerName, this, ctx, {
      context: input.context,
      workDir,
      signal,
      onProgress: (message) => {
        this.progressStore.appendProgress(jobId, sessionId, message);
      },
      workflowJobId: jobId,
      progressStore: this.progressStore,
    })
      .then((result: PipelineResult) => {
        const serialized = serializeWorkflowResult(result.stepDetails);
        this.finishWorkflowJob(
          sessionId,
          jobId,
          'completed',
          {
            content: result.finalOutput,
            workflow: serialized.workflow,
          },
          serialized.markdown,
        );
      })
      .catch((err: unknown) => {
        this.handleWorkflowError(err, signal, sessionId, jobId);
      });
  }

  /**
   * Resume a workflow coordinator from a persisted checkpoint.
   * Reads the checkpoint, reconstructs the active step, and re-enters the
   * pipeline via `resumePipeline`.
   */
  resumeWorkflowCoordinator(
    jobId: string,
    sessionId: string,
    ast: PipelineAST,
    providerName: string,
    ctx: CallerContext,
    options: {
      context?: string;
      workDir?: string;
    },
  ): void {
    const checkpoint = this.progressStore.readWorkflowCheckpoint(jobId);
    if (!checkpoint) return;

    const signal = this.abortRegistry.getSignal(jobId);
    if (!signal) return;

    void resumePipeline(checkpoint, ast, providerName, this, ctx, {
      context: options.context,
      workDir: options.workDir,
      signal,
      workflowJobId: jobId,
      progressStore: this.progressStore,
      onProgress: (message) => {
        this.progressStore.appendProgress(jobId, sessionId, message);
      },
    })
      .then((result: PipelineResult) => {
        const serialized = serializeWorkflowResult(result.stepDetails);
        this.finishWorkflowJob(
          sessionId,
          jobId,
          'completed',
          {
            content: result.finalOutput,
            workflow: serialized.workflow,
          },
          serialized.markdown,
        );
      })
      .catch((err: unknown) => {
        this.handleWorkflowError(err, signal, sessionId, jobId);
      });
  }

  private handleWorkflowError(err: unknown, signal: AbortSignal, sessionId: string, jobId: string): void {
    const message = errorMessage(err);
    const aborted = err instanceof WorkflowExecutionError ? err.aborted : signal.aborted;
    const phase: Extract<JobPhase, 'error' | 'aborted'> = aborted ? 'aborted' : 'error';
    const stepDetails = err instanceof WorkflowExecutionError ? err.stepDetails : [];

    try {
      const serialized = serializeWorkflowResult(stepDetails);
      const terminalResult: TerminalResult = aborted
        ? { content: '', aborted: true, notice: message, workflow: serialized.workflow }
        : { content: '', notice: message, workflow: serialized.workflow };
      this.finishWorkflowJob(sessionId, jobId, phase, terminalResult, serialized.markdown);
    } catch {
      const emptyResult: TerminalResult = aborted
        ? { content: '', aborted: true, notice: message, workflow: { steps: [] } }
        : { content: '', notice: message, workflow: { steps: [] } };
      this.finishWorkflowJob(sessionId, jobId, phase, emptyResult, '');
    }
  }
}
