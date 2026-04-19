import type {
  ArtifactCleanupRuntime,
  ProviderContinuityBlob,
  ProviderExecutor,
  PreflightRuntime,
  ProviderArtifactCleanup,
  ProviderRecoveryMeta,
  ProviderServerLease,
  ProviderServerSpec,
} from '../providers/types.js';
import { backendLog } from '../shared/backend-log.js';
import type { AbortResult } from '../shared/execution-contracts.js';
import { getCallerContext, withCallerContext } from './caller-context.js';
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
  type JobLaunchRecord,
  type JobRuntimeRecord,
  type ProviderInstruction,
  type ProviderRequest,
  type ProviderTurnResult,
  type SessionEntry,
  type JobTerminalRecord,
  type WaitStreamEvent,
  type WaitStreamRequest,
  type WorkflowResultMeta,
} from '../shared/types.js';
import { errorMessage, nowIsoString } from '../shared/utils.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { DiscussContext } from '../discuss/shell/context.js';
import type { DiscussDetailResponse, DiscussSummaryDto, DiscussView } from '../discuss/views.js';
import type { KnowledgeBaseRuntime } from '../execution/kb-tools.js';
import type { PipelineAST } from '../workflow/ast.js';
import {
  WorkflowExecutionError,
  type PipelineResult,
  type StepDetail,
  type WorkflowSessionHandle,
} from '../workflow/command.js';
import { executePipeline } from '../workflow/executor.js';
import { createWorkflowJournal } from '../workflow/projections.js';
import {
  describeLegacyCoralFault,
  type RecoveryFaultCompat,
} from '../shared/legacy-terminal-outcome-compat.js';
import { type AbortReason, type TerminalOutcome } from '../jobs/outcome.js';
import { materializeLegacyTerminalOutcome, planLegacyTerminalOutcome } from '../jobs/shell/legacy-ingest.js';
import { AbortRegistry } from '../jobs/shell/abort-registry.js';
import type { TypedEventBus } from './control.js';
import type { LaunchCoordinator, LaunchPool } from './live/admission.js';
import { type ProviderHostManager, type ProviderServerAttachment } from './live/provider-hosts/pool.js';
import { buildCoralInstruction } from '../jobs/shell/instruction.js';
import { LaunchOrchestrator, WaitCoordinator } from '../execution/job-lifecycle.js';
import {
  SessionClaimError,
  WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS,
  rejectLaunch,
  toProviderRequest,
  type AcceptedAdmission,
  type ClaimJobOptions,
} from '../execution/job-lifecycle-contracts.js';
import type { ProgressStore } from '../execution/progress-store.js';
import {
  parseAgentRef,
  resolveAgent,
  stripAgentMetadata,
  parseAgentMeta,
  InvalidAgentRefError,
  AgentNotFoundError,
  AgentNamespaceNotFoundError,
  type AgentResolutionContext,
} from '../jobs/shell/agent-resolution.js';
import { SessionManager, getSessionById, type SessionAllocateOptions } from '../execution/session-manager.js';
import type { Runtime } from '../runtime/ports.js';
import { noopAppendEvents, type AppendEventsFn } from '../store/append.js';
import type { CoralEventInput } from '../store/envelope.js';
import type { JobProjectionDetail, JobProgressRow } from '../store/queries/jobs.js';
import type { JobEvent } from '../jobs/shell/event-subscription.js';
import { writeWorkflowResult } from '../jobs/shell/result-artifact.js';
import type { BackendIdentity, EventBusEvents, ReadonlyRuntimeState } from './control.js';
import type { IdleTimer } from './live/idle.js';

interface LaunchIntentBase {
  prompt: string;
  name?: string;
  model?: string;
  cwd?: string;
  jobId?: string;
  workflowSlotId?: string;
  /** Set only by coralDispatch (agent metadata). */
  effort?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  instruction?: ProviderInstruction;
  /** Parent workflow job ID for atom launches. */
  parentWorkflowJobId?: string;
}

type ExecIntent = LaunchIntentBase & { agent?: string; pool?: LaunchPool };
type ResumeIntent = LaunchIntentBase & { sessionId: string; provider?: string; agent?: string; pool?: LaunchPool };
type ForkIntent = Omit<LaunchIntentBase, 'prompt'> & { sessionId: string; provider?: string; prompt?: string };
type CoralIntent = Omit<LaunchIntentBase, 'effort'> & { sessionId?: string; effort?: EffortLevel };

export interface SessionRequestPort {
  start(providerName: string, input: ExecIntent, ctx: CallerContext): Promise<LaunchDecision>;
  resumeBySessionId(input: ResumeIntent, ctx: CallerContext): Promise<LaunchDecision>;
  forkBySessionId(input: ForkIntent, ctx: CallerContext): Promise<LaunchDecision>;
}

export interface JobsRequestPort {
  abort(jobIds: string[]): AbortResult;
  waitStream(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent>;
  waitStreamOnce(jobId: string, timeoutMs?: number): Promise<{ content: string; nonResumable: boolean }>;
  awaitLaunch(jobId: string, timeoutMs: number): Promise<LaunchState>;
  list(providerName: string): ListResult;
}

export interface WorkflowRequestPort {
  executeWorkflow(
    providerName: string,
    ast: PipelineAST,
    input: WorkflowCommand,
    ctx: CallerContext,
    workDir?: string,
  ): Promise<LaunchDecision>;
}

export interface KbRequestPort {
  getSubsystem(): KnowledgeBaseRuntime | null;
}

export interface DiscussRequestPort {
  getContext(ctx: CallerContext): DiscussContext;
}

export interface AdminControlPort {
  isDrainRequested(): boolean;
  requestDrain(reason: string): void;
}

export type ProjectRequestPort = SessionRequestPort & JobsRequestPort & WorkflowRequestPort;
export type ExecutionServiceLike = ProjectRequestPort;

export type ScopeCheckResult = {
  valid: string[];
  missing: string[];
  mismatch: string[];
};

export interface ListResult {
  sessions: SessionEntry[];
}

export interface EventStreamHandlers {
  onJobCreated: (payload: EventBusEvents['job:created']) => void;
  onPhaseChanged: (payload: EventBusEvents['job:phase_changed']) => void;
  onProgress: (payload: EventBusEvents['job:progress']) => void;
  onCompleted: (payload: EventBusEvents['job:completed']) => void;
  onDiscussUpdated: (payload: EventBusEvents['discuss:updated']) => void;
}

export interface HttpHandlerDeps {
  readonly identity: BackendIdentity;
  readonly runtime: Pick<Runtime, 'ids' | 'time' | 'storage'>;
  readonly runtimeState: ReadonlyRuntimeState;
  readonly idleTimer: IdleTimer;
  readonly progressStore: ProgressStore;
  readonly activeLaunchCount: () => number;
  readonly queueDepth: () => number;
  readonly streamResponses: Set<ServerResponse>;
  readonly coralEnvSnapshot: Readonly<Record<string, string>>;
  readonly resolveProjectSource: (projectRoot: string) => string;
  isDrainRequested(): boolean;
  requestDrain(reason: string): void;
  readonly getExecutionService: (ctx: CallerContext) => ProjectRequestPort;
  readonly getDiscussContext: (ctx: CallerContext) => DiscussContext;
  readonly providerRegistry: ProviderRegistry;
  readonly abortJobs: (jobIds: string[]) => AbortResult;
  readonly scopeCheckJobs: (jobIds: string[], projectRoot: string) => ScopeCheckResult;
  readonly subscribeBackendEvents: (handlers: EventStreamHandlers) => void;
  readonly unsubscribeBackendEvents: (handlers: EventStreamHandlers) => void;
  readonly liveDiscussCount: () => number;
  readonly listDiscussSessions: () => DiscussSummaryDto[];
  readonly loadDiscussDetail: (
    source: string,
    sessionId: string,
    view: DiscussView,
  ) => DiscussDetailResponse | 'audit_requires_ended_session' | null;
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
  effort?: EffortLevel;
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

function buildInterruptedAppServerReport(
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

function normalizeLegacyFaultOutcome(jobId: string, sessionId: string, fault: RecoveryFaultCompat): TerminalOutcome {
  const plan = planLegacyTerminalOutcome({ kind: 'legacy_fault', fault }, { jobId, sessionId });
  if (plan.immediateOutcome !== null) {
    return plan.immediateOutcome;
  }

  return materializeLegacyTerminalOutcome(
    plan,
    plan.domainEvents.map((event, index) => ({
      seq: index + 1,
      stream: event.stream,
    })),
  );
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
  appendEvents?: AppendEventsFn;
  loadJobProjectionDetail?: (jobId: string) => JobProjectionDetail;
  readJobProgress?: (jobId: string) => JobProgressRow[];
  subscribeJobEvents?: (options: {
    afterSeq: number;
    jobIds: readonly string[];
    abortSignal?: AbortSignal;
  }) => AsyncIterable<JobEvent>;
  getCurrentJournalSeq?: () => number;
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

function toPreflightRuntime(runtime: Runtime): PreflightRuntime {
  return {
    process: runtime.process,
    storage: runtime.storage,
    env: runtime.env,
  };
}

function toArtifactCleanupRuntime(runtime: Runtime): ArtifactCleanupRuntime {
  return {
    storage: runtime.storage,
    env: runtime.env,
  };
}

export interface WorkflowSessionCleanupDeps {
  resolveConversationRef(providerName: string, sessionId: string): string | undefined;
  getArtifactCleanup(providerName: string): ProviderArtifactCleanup | undefined;
  cleanupRuntime: ArtifactCleanupRuntime;
  onError(message: string): void;
}

/**
 * Pure dispatch core for `ExecutionService.cleanupWorkflowSessions`.
 * Groups handles by provider, resolves conversation refs, and fires cleanup
 * per-provider. Exported so tests can exercise grouping and error surfacing
 * without standing up a full ExecutionService.
 */
export function dispatchWorkflowSessionCleanup(
  sessions: readonly WorkflowSessionHandle[],
  deps: WorkflowSessionCleanupDeps,
): void {
  if (sessions.length === 0) return;

  const refsByProvider = new Map<string, Set<string>>();
  for (const handle of sessions) {
    const ref = deps.resolveConversationRef(handle.providerName, handle.sessionId);
    if (!ref) continue;
    const bucket = refsByProvider.get(handle.providerName) ?? new Set<string>();
    bucket.add(ref);
    refsByProvider.set(handle.providerName, bucket);
  }
  if (refsByProvider.size === 0) return;

  for (const [providerName, refs] of refsByProvider) {
    const artifactCleanup = deps.getArtifactCleanup(providerName);
    if (!artifactCleanup?.cleanupSessions) continue;
    void artifactCleanup.cleanupSessions(deps.cleanupRuntime, [...refs]).catch((error: unknown) => {
      deps.onError(`Provider ${providerName} session cleanup failed: ${errorMessage(error)}`);
    });
  }
}

async function runProviderPreflight(provider: ProviderExecutor, runtime: PreflightRuntime): Promise<string | null> {
  if (!provider.preflight) return null;
  try {
    await provider.preflight(runtime);
    return null;
  } catch (error: unknown) {
    return errorMessage(error);
  }
}

/** Recovery-oriented interface for lifecycle startup/handoff/restart. */
export interface RecoveryCapableService {
  finalizeInterruptedAppServerJob(
    launchRecord: JobLaunchRecord,
    runtimeRecord: AppServerRuntimeRecord,
    context: { reason: 'restart' | 'handoff' },
  ): Promise<void>;
  adoptRunningJob(launchRecord: JobLaunchRecord, runtimeRecord: JobRuntimeRecord): { cleanup: () => void };
  recoverQueuedJob(launchRecord: JobLaunchRecord): string;
  interruptAppServerJob(launchRecord: JobLaunchRecord, runtimeRecord: AppServerRuntimeRecord): Promise<void>;
  completeRecoveredJob(
    jobId: string,
    sessionId: string,
    result: JobTerminalRecord,
    phase: JobPhase,
    options?: { conversationRef?: string; nonResumable?: boolean },
  ): void;
}

export class ExecutionService implements RecoveryCapableService, ProjectRequestPort {
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
  private readonly appendEvents: AppendEventsFn;
  private readonly loadJobProjectionDetail?: (jobId: string) => JobProjectionDetail;
  private readonly readJobProgress?: (jobId: string) => JobProgressRow[];
  private readonly subscribeJobEvents?: (options: {
    afterSeq: number;
    jobIds: readonly string[];
    abortSignal?: AbortSignal;
  }) => AsyncIterable<JobEvent>;
  private readonly getCurrentJournalSeq?: () => number;
  private callerCorrelationSeq = 0;

  constructor(ctx: CallerContext, deps: ExecutionServiceDeps) {
    this.projectRoot = ctx.projectRoot;
    this.runtime = deps.runtime;
    this.eventBus = deps.eventBus;
    this.sessionManager = new SessionManager(ctx.projectRoot, deps.runtime, deps.appendEvents ?? noopAppendEvents);
    this.abortRegistry = new AbortRegistry(deps.runtime.ids);
    this.backendNamespace = deps.backendNamespace;
    this.bundleHash = deps.bundleHash ?? 'unknown';
    this.progressStore = deps.progressStore;
    this.providerHostManager = deps.providerHostManager;
    this.launchCoordinator = deps.launchCoordinator;
    this.providerRegistry = deps.providerRegistry;
    this.pluginRegistry = deps.pluginRegistry;
    this.appendEvents = deps.appendEvents ?? noopAppendEvents;
    this.loadJobProjectionDetail = deps.loadJobProjectionDetail;
    this.readJobProgress = deps.readJobProgress;
    this.subscribeJobEvents = deps.subscribeJobEvents;
    this.getCurrentJournalSeq = deps.getCurrentJournalSeq;
    this.launchOrchestrator = new LaunchOrchestrator({
      abortRegistry: this.abortRegistry,
      progressStore: this.progressStore,
      sessionManager: this.sessionManager,
      launchCoordinator: this.launchCoordinator,
      runtime: this.runtime,
      backendNamespace: this.backendNamespace,
      bundleHash: this.bundleHash,
      jobPools: this.jobPools,
      appendEvents: this.appendEvents,
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
      loadJobProjectionDetail: this.loadJobProjectionDetail,
      readJobProgress: this.readJobProgress,
      subscribeJobEvents: this.subscribeJobEvents,
      getCurrentJournalSeq: this.getCurrentJournalSeq,
    });
  }

  private runWithCallerContext<T>(ctx: CallerContext, run: () => T): T {
    return withCallerContext(
      {
        namespace: this.backendNamespace,
        project: ctx.projectRoot,
        correlationId: `${this.backendNamespace}:${this.projectRoot}:${++this.callerCorrelationSeq}`,
      },
      run,
    );
  }

  private resolveJobEventMetadata(
    jobId: string,
    projectRoot?: string,
  ): Pick<CoralEventInput, 'correlationId' | 'namespace' | 'project'> {
    const caller = getCallerContext();
    if (caller) {
      return {
        namespace: caller.namespace,
        project: caller.project,
        correlationId: caller.correlationId,
      };
    }

    const launch = this.progressStore.readLaunchRecord(jobId);
    const status = this.progressStore.readStatus(jobId);
    return {
      namespace: launch?.backendNamespace ?? status?.backendNamespace ?? this.backendNamespace,
      project: launch?.projectRoot ?? status?.projectRoot ?? projectRoot,
      correlationId: undefined,
    };
  }

  private appendJobEvent(
    jobId: string,
    sessionId: string,
    type: CoralEventInput['type'],
    body: unknown,
    options: { projectRoot?: string } = {},
  ): void {
    const metadata = this.resolveJobEventMetadata(jobId, options.projectRoot);
    this.appendEvents([
      {
        type,
        stream: { kind: 'job', id: jobId },
        namespace: metadata.namespace,
        project: metadata.project,
        correlationId: metadata.correlationId,
        refs: { jobId, sessionId },
        bodyVersion: 1,
        body,
      },
    ]);
  }

  private appendJobProgressEvent(jobId: string, sessionId: string, message: string): void {
    this.appendJobEvent(jobId, sessionId, 'job.progress.emitted', {
      kind: 'message',
      message,
      ts: nowIsoString(this.runtime.time),
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
    launchRecord: JobLaunchRecord,
    runtimeRecord: AppServerRuntimeRecord,
  ): Promise<void> {
    const appServerLifecycle = this.providerRegistry.getAppServerLifecycle(launchRecord.provider);
    if (!appServerLifecycle) {
      return;
    }
    const session = this.sessionManager.get(launchRecord.provider, launchRecord.sessionId);
    const continuity = this.resolveAppServerContinuity(launchRecord.provider, runtimeRecord, session);
    if (!continuity) {
      return;
    }

    const spec = appServerLifecycle.buildServerSpec(continuity, toProviderRequest(launchRecord));
    if (spec.shared !== true) {
      const liveServer = await this.providerHostManager.borrowLiveServer(spec, {
        serverGeneration: runtimeRecord.providerMeta.serverGeneration,
      });
      if (liveServer) {
        await appServerLifecycle.interrupt(this.createAttachedProviderServerLease(liveServer), continuity);
        return;
      }
    }

    const lease = await this.acquireServer(spec);
    try {
      await appServerLifecycle.interrupt(lease, continuity);
    } finally {
      lease.release();
    }
  }

  async finalizeInterruptedAppServerJob(
    launchRecord: JobLaunchRecord,
    runtimeRecord: AppServerRuntimeRecord,
    options: { reason: InterruptedAppServerReason },
  ): Promise<void> {
    const status = this.progressStore.readStatus(launchRecord.jobId);
    if (!status || isTerminalPhase(status.phase)) {
      return;
    }

    const appServerLifecycle = this.providerRegistry.getAppServerLifecycle(launchRecord.provider);
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

    if (appServerLifecycle && continuity) {
      if (runtimeRecord.providerMeta.leaseState === 'waiting') {
        probeOutcome = 'waiting';
        mutation = toMutation(
          appServerLifecycle.finalizeInterrupted(
            {
              resumable: Boolean(preservedConversationRef ?? continuity),
              updatedContinuity: continuity,
            },
            continuity,
          ),
        );
      } else {
        const spec = appServerLifecycle.buildServerSpec(continuity, toProviderRequest(launchRecord));

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
            const probeResult = await appServerLifecycle.probe(lease, continuity);
            probeOutcome = probeResult.resumable ? 'verified' : 'missing';
            mutation = toMutation(appServerLifecycle.finalizeInterrupted(probeResult, continuity));
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
            appServerLifecycle.finalizeInterrupted(
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

    const fault: Extract<RecoveryFaultCompat, { kind: 'app_server_interrupted' }> = {
      kind: 'app_server_interrupted',
      trigger: options.reason,
      continuity:
        probeOutcome === 'verified'
          ? 'verified'
          : probeOutcome === 'missing'
            ? 'missing'
            : probeOutcome === 'unavailable'
              ? 'unavailable'
              : mutation.type === 'clear_non_resumable'
                ? 'pre_checkpoint_empty'
                : 'pre_checkpoint_preserved',
    };

    let reportConversationRef: string | undefined;
    if (probeOutcome === 'verified') {
      reportConversationRef = mutation.type === 'set_resumable' ? mutation.conversationRef : preservedConversationRef;
    }

    const interruptedReport = buildInterruptedAppServerReport(fault, reportConversationRef);
    const outcome = normalizeLegacyFaultOutcome(launchRecord.jobId, launchRecord.sessionId, fault);

    this.progressStore.updateLaunchState(launchRecord.jobId, 'error', describeLegacyCoralFault(fault));
    this.writeJobTerminalRecord(
      launchRecord.jobId,
      launchRecord.sessionId,
      {
        content: interruptedReport,
        outcome,
        ...(probeOutcome === 'missing' || probeOutcome === 'unavailable' ? { nonResumable: true } : {}),
      },
      'error',
    );
    this.progressStore.writeResultMd(launchRecord.jobId, interruptedReport);
    writeWorkflowResult(launchRecord.jobId, interruptedReport);
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

    return this.providerRegistry
      .getAppServerLifecycle(providerName)
      ?.migrateLegacyContinuity?.(runtimeRecord.providerMeta as Record<string, unknown>);
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
    const launch = this.progressStore.readLaunchRecord(jobId);
    if (launch) {
      this.appendJobEvent(
        jobId,
        launch.sessionId,
        'job.runtime.started',
        {
          transport: 'app-server',
          startedAt: record.startTime,
          providerMeta: record.providerMeta,
        },
        { projectRoot: launch.projectRoot },
      );
    }
  }

  private resolveSessionByIdForContinuation(
    sessionId: string,
    ctx: CallerContext,
    expectedProvider?: string,
  ): { providerName: string; session: SessionEntry } | LaunchDecision {
    const session = getSessionById(sessionId, this.runtime);
    if (!session) {
      return rejectLaunch('session_not_found', `Session not found: ${sessionId}. Use exec to start a new session.`);
    }
    if (expectedProvider !== undefined && session.provider !== expectedProvider) {
      return rejectLaunch(
        'provider_mismatch',
        `Session ${sessionId} belongs to provider '${session.provider}'. Use \`coral-cli ${session.provider} -s ${sessionId} ...\` instead.`,
      );
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
      effort: resolveEffort(input.effort),
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
    provider: ProviderExecutor,
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

    const preflightError = await runProviderPreflight(provider, toPreflightRuntime(this.runtime));
    if (preflightError) return rejectLaunch('preflight_failed', preflightError);

    const admitted = await this.claimAndAdmitJob(
      session,
      providerName,
      ctx.projectRoot,
      busyMessage,
      expectedVersion,
      pool,
      input.jobId,
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
      workflowSlotId: input.workflowSlotId,
    });
  }

  private async forkResolved(
    providerName: string,
    provider: ProviderExecutor,
    sourceSession: SessionEntry,
    input: ForkIntent,
    ctx: CallerContext,
  ): Promise<LaunchDecision> {
    const sourceBusyMessage = `Session ${input.sessionId} already has an active job. Wait for it to complete or abort it first.`;
    if (sourceSession.activeJobId) {
      return rejectLaunch('session_busy', sourceBusyMessage);
    }
    const sourceExpectedVersion = sourceSession.version;

    const preflightError = await runProviderPreflight(provider, toPreflightRuntime(this.runtime));
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
        workflowSlotId: input.workflowSlotId,
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
    requestedJobId?: string,
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
      requestedJobId,
    );
  }

  private launchProviderJob(
    provider: ProviderExecutor,
    sessionId: string,
    jobId: string,
    request: ProviderRequest,
    admission: AcceptedAdmission,
    opts: { pool?: LaunchPool; projectRoot?: string; parentWorkflowJobId?: string; workflowSlotId?: string } = {},
  ): LaunchDecision {
    return this.launchOrchestrator.launchProviderJob(provider, sessionId, jobId, request, admission, opts);
  }

  async start(providerName: string, input: ExecIntent, ctx: CallerContext): Promise<LaunchDecision> {
    return this.runWithCallerContext(ctx, async () => {
      const provider = this.providerRegistry.getExecutor(providerName);
      if (!provider) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

      const preflightError = await runProviderPreflight(provider, toPreflightRuntime(this.runtime));
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
        input.jobId,
      );
      if ('status' in admitted) return admitted;

      const request: ProviderRequest = {
        action: 'exec',
        sessionId: session.sessionId,
        name: requestName,
        prompt: input.prompt,
        model,
        cwd,
        effort: resolveEffort(input.effort),
        bypassPermissions,
        systemPrompt: input.systemPrompt,
        instruction,
        coralEnv: effectiveCoralEnv,
      };

      return this.launchProviderJob(provider, session.sessionId, admitted.jobId, request, admitted.admission, {
        pool,
        projectRoot: ctx.projectRoot,
        parentWorkflowJobId: input.parentWorkflowJobId,
        workflowSlotId: input.workflowSlotId,
      });
    });
  }

  async resume(providerName: string, input: ResumeIntent, ctx: CallerContext): Promise<LaunchDecision> {
    return this.runWithCallerContext(ctx, async () => {
      const provider = this.providerRegistry.getExecutor(providerName);
      if (!provider) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

      const session = this.sessionManager.get(providerName, input.sessionId);
      if (!session)
        return rejectLaunch(
          'session_not_found',
          `Session not found: ${input.sessionId}. Use exec to start a new session.`,
        );

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
    });
  }

  async fork(providerName: string, input: ForkIntent, ctx: CallerContext): Promise<LaunchDecision> {
    return this.runWithCallerContext(ctx, async () => {
      const provider = this.providerRegistry.getExecutor(providerName);
      if (!provider) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

      const sourceSession = this.sessionManager.get(providerName, input.sessionId);
      if (!sourceSession)
        return rejectLaunch(
          'session_not_found',
          `Session not found: ${input.sessionId}. Use exec to start a new session.`,
        );
      return this.forkResolved(providerName, provider, sourceSession, input, ctx);
    });
  }

  async resumeBySessionId(input: ResumeIntent, ctx: CallerContext): Promise<LaunchDecision> {
    return this.runWithCallerContext(ctx, async () => {
      const resolved = this.resolveSessionByIdForContinuation(input.sessionId, ctx, input.provider);
      if ('status' in resolved) return resolved;

      const provider = this.providerRegistry.getExecutor(resolved.providerName);
      if (!provider) return rejectLaunch('unknown_provider', `Unknown provider: ${resolved.providerName}`);

      return this.resumeResolved(resolved.providerName, provider, resolved.session, input, ctx);
    });
  }

  async forkBySessionId(input: ForkIntent, ctx: CallerContext): Promise<LaunchDecision> {
    return this.runWithCallerContext(ctx, async () => {
      const resolved = this.resolveSessionByIdForContinuation(input.sessionId, ctx, input.provider);
      if ('status' in resolved) return resolved;

      const provider = this.providerRegistry.getExecutor(resolved.providerName);
      if (!provider) return rejectLaunch('unknown_provider', `Unknown provider: ${resolved.providerName}`);

      return this.forkResolved(resolved.providerName, provider, resolved.session, input, ctx);
    });
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
          jobId: input.jobId,
          workflowSlotId: input.workflowSlotId,
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
        jobId: input.jobId,
        workflowSlotId: input.workflowSlotId,
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
    if (!this.providerRegistry.getExecutor(providerName)) {
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

  cleanupWorkflowSessions(sessions: readonly WorkflowSessionHandle[]): void {
    dispatchWorkflowSessionCleanup(sessions, {
      resolveConversationRef: (providerName, sessionId) =>
        this.sessionManager.get(providerName, sessionId)?.conversationRef,
      getArtifactCleanup: (providerName) => this.providerRegistry.getArtifactCleanup(providerName),
      cleanupRuntime: toArtifactCleanupRuntime(this.runtime),
      onError: (message) => backendLog.warn(message),
    });
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
        this.finishQueuedAbort(jobId, status.sessionId, 'queue_shutdown');
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
  recoverQueuedJob(launchRecord: JobLaunchRecord): string {
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
    const provider = this.providerRegistry.getExecutor(launchRecord.provider);
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
  adoptRunningJob(launchRecord: JobLaunchRecord, runtimeRecord: JobRuntimeRecord): { cleanup: () => void } {
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
    result: JobTerminalRecord,
    phase: JobPhase,
    options?: { conversationRef?: string; nonResumable?: boolean },
  ): void {
    this.writeJobTerminalRecord(jobId, sessionId, result, phase);
    this.progressStore.writeResultMd(jobId, result.content);
    writeWorkflowResult(jobId, result.content);
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
    result: ProviderTurnResult,
  ): Promise<void> {
    const appServerLifecycle = this.providerRegistry.getAppServerLifecycle(providerName);
    const runtimeRecord = this.progressStore.readRuntimeRecord(jobId);
    if (appServerLifecycle && isAppServerRuntime(runtimeRecord)) {
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
    if (this.loadJobProjectionDetail && this.subscribeJobEvents && this.getCurrentJournalSeq) {
      const current = this.loadJobProjectionDetail(jobId).status;
      if (current && current.launch.state !== 'pending') {
        return current.launch.state;
      }

      const controller = new AbortController();
      const iterator = this.subscribeJobEvents({
        afterSeq: this.getCurrentJournalSeq(),
        jobIds: [jobId],
        abortSignal: controller.signal,
      })[Symbol.asyncIterator]();

      try {
        const start = this.runtime.time.now();
        while (true) {
          const status = this.loadJobProjectionDetail(jobId).status;
          if (status && status.launch.state !== 'pending') {
            return status.launch.state;
          }

          const remainingMs = timeoutMs - (this.runtime.time.now() - start);
          if (remainingMs <= 0) {
            return 'pending';
          }

          await Promise.race([
            iterator.next(),
            this.runtime.time.sleep(remainingMs),
          ]);
        }
      } finally {
        controller.abort();
        await iterator.return?.();
      }
    }

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
  async *waitStream(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent> {
    yield* this.waitCoordinator.waitForJobs(req);
  }

  async waitStreamOnce(jobId: string, timeoutMs?: number): Promise<{ content: string; nonResumable: boolean }> {
    return this.waitCoordinator.waitStreamOnce(jobId, timeoutMs);
  }

  private finishQueuedAbort(jobId: string, sessionId: string, reason: AbortReason): void {
    this.launchOrchestrator.finishQueuedAbort(jobId, sessionId, reason);
  }

  private markJobRunning(jobId: string): void {
    this.launchOrchestrator.markJobRunning(jobId);
  }

  private finishWorkflowJob(
    sessionId: string,
    jobId: string,
    phase: Extract<JobPhase, 'completed' | 'error' | 'aborted'>,
    result: JobTerminalRecord,
    markdown: string,
  ): void {
    this.progressStore.writeWorkflowResultMdOrThrow(jobId, markdown);
    writeWorkflowResult(jobId, markdown);
    this.writeJobTerminalRecord(jobId, sessionId, result, phase);
    this.sessionManager.setNonResumable(sessionId);
    this.abortRegistry.remove(jobId);
    this.sessionManager.releaseJob(sessionId, jobId);
  }

  private writeJobTerminalRecord(jobId: string, sessionId: string, result: JobTerminalRecord, phase: JobPhase): void {
    this.launchOrchestrator.writeJobTerminalRecord(jobId, sessionId, result, phase);
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
        this.appendJobProgressEvent(jobId, sessionId, message);
      },
      workflowJobId: jobId,
      journal: createWorkflowJournal({ appendEvents: this.appendEvents }),
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
            outcome: { kind: 'completed' },
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
    const workflowError = err instanceof WorkflowExecutionError ? err : null;
    const aborted = workflowError ? workflowError.aborted : signal.aborted;
    const stepDetails = err instanceof WorkflowExecutionError ? err.stepDetails : [];
    const outcome: TerminalOutcome = workflowError?.terminalOutcome
      ?? (aborted
        ? { kind: 'aborted', reason: 'signal_abort' }
        : { kind: 'job_fault', fault: { kind: 'wrapper_crashed', cause: { message } } });

    try {
      const serialized = serializeWorkflowResult(stepDetails);
      const terminalResult: JobTerminalRecord = {
        content: '',
        outcome,
        workflow: serialized.workflow,
      };
      this.finishWorkflowJob(sessionId, jobId, 'error', terminalResult, serialized.markdown);
    } catch {
      const emptyResult: JobTerminalRecord = {
        content: '',
        outcome,
        workflow: { steps: [] },
      };
      this.finishWorkflowJob(sessionId, jobId, 'error', emptyResult, '');
    }
  }
}
import type { ServerResponse } from 'node:http';
