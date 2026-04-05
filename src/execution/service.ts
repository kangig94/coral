import { randomUUID } from 'node:crypto';
import { pluginRootNamespace } from '../infra/paths.js';
import {
  isAppServerRuntime,
  isDurableCliRuntime,
  isTerminalPhase,
  type AppServerRuntimeRecord,
  type JobKind,
  type JobPhase,
  type LaunchDecision,
  type LaunchState,
  type PersistedLaunchRecord,
  type PersistedRuntimeRecord,
  type PersistedStatusRecord,
  type ProviderInstruction,
  type ProviderProgressEvent,
  type ProviderRequest,
  type ProviderResult,
  type TerminalResult,
  type SessionEntry,
  type WaitRequest,
  type WaitStreamEvent,
  type WorkflowResultMeta,
} from '../shared/types.js';
import { resolveCoralContent, stripAgentMetadata, parseAgentMeta } from './resolver.js';
import type { ProviderCliRunner } from '../providers/runner-port.js';
import { errorMessage } from '../shared/mcp-utils.js';
import { backendLog } from '../shared/backend-log.js';
import type { EffortLevel } from '../shared/schemas.js';
import type {
  Provider,
  ProviderContinuityBlob,
  ProviderRecoveryMeta,
  ProviderRuntime,
  ProviderServerLease,
  ProviderServerSpec,
} from '../providers/types.js';
import {
  executePipeline,
  resumePipeline,
  type PipelineResult,
  type StepDetail,
  WorkflowExecutionError,
} from '../workflow/pipe-executor.js';
import type { WorkflowInput } from '../workflow/schemas.js';
import type { PipelineAST } from '../workflow/types.js';
import {
  CliBusyError,
  LaunchCoordinator,
  type AdmissionResult,
  type LaunchPool,
  type QueuedHandle,
} from './engine.js';
import { AbortRegistry, type AbortResult } from './abort-registry.js';
import { buildCoralInstruction } from './instruction.js';
import { ProgressStore, createReplayCursor, jobResultPath } from './progress-store.js';
import { SessionManager } from './session-manager.js';
import { TypedEventBus } from './event-bus.js';
import {
  type ProviderHostManager,
  type ProviderServerAttachment,
} from './host-manager.js';
import type { ProviderRegistry } from '../providers/registry.js';

import type { CallerContext } from './request-context.js';
export type { CallerContext } from './request-context.js';

declare const __PLUGIN_ROOT__: string;

export interface ExecInput {
  prompt: string;
  name?: string;
  model?: string;
  pool?: LaunchPool;
  cwd?: string;
  /** Set only by coralDispatch (agent metadata). MCP input never populates this. */
  effort?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  instruction?: ProviderInstruction;
  /** Parent workflow job ID for atom launches. */
  parentWorkflowJobId?: string;
}

export interface ResumeInput {
  sessionId: string;
  prompt: string;
  name?: string;
  model?: string;
  pool?: LaunchPool;
  cwd?: string;
  /** Set only by coralDispatch (agent metadata). MCP input never populates this. */
  effort?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  instruction?: ProviderInstruction;
  /** Parent workflow job ID for atom launches. */
  parentWorkflowJobId?: string;
}

export interface ForkInput {
  sessionId: string;
  name?: string;
  prompt?: string;
  model?: string;
  cwd?: string;
  /** Set only by coralDispatch (agent metadata). MCP input never populates this. */
  effort?: string;
  bypassPermissions?: boolean;
  systemPrompt?: string;
  instruction?: ProviderInstruction;
}

export interface CoralInput {
  prompt: string;
  sessionId?: string;
  cwd?: string;
  effort?: EffortLevel;
  /** Parent workflow job ID for atom launches. */
  parentWorkflowJobId?: string;
}

export interface ListResult {
  sessions: SessionEntry[];
}

const QUEUE_FULL_MESSAGE = 'All slots and queue are full. Try again later.';
const QUEUED_ABORT_MESSAGE = 'Aborted while queued.';
const FINALIZE_CONTINUITY_MAX_RETRIES = 2;
const WAIT_FOR_JOB_TERMINAL_TIMEOUT_MS = 30_000;
const defaultPluginRoot = typeof __PLUGIN_ROOT__ === 'string' ? __PLUGIN_ROOT__ : process.cwd();

type AcceptedAdmission = Exclude<AdmissionResult, 'queue_full'>;

type InterruptedAppServerReason = 'restart' | 'handoff';
type InterruptedProbeOutcome = 'verified' | 'missing' | 'unavailable' | 'waiting';
type InterruptedAppServerFinalization = {
  conversationRef?: string;
  nonResumable?: boolean;
  continuityMutation?: ProviderContinuityBlob;
};

const APP_SERVER_RECOVERY_POLICY = 'session_continuity_only' as const;
const APP_SERVER_RESTART_NOTICE = 'Backend restarted during the app-server turn. The interrupted turn was not replayed.';
const APP_SERVER_HANDOFF_NOTICE = 'Backend handoff interrupted the app-server turn. The interrupted turn was not replayed.';
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

function bindProviderRunner(
  launchCoordinator: LaunchCoordinator,
  provider: string,
  signal: AbortSignal,
  pool: LaunchPool,
  jobDir: string,
): ProviderCliRunner {
  return (request) =>
    launchCoordinator.spawnDurableJob({
      provider,
      signal,
      permitGranted: true,
      pool,
      jobDir,
      command: request.command,
      args: request.args,
      prompt: request.prompt,
      cwd: request.cwd,
      extraEnv: request.extraEnv,
      onEvent: request.onEvent,
    });
}

export type ExecutionServiceDeps = {
  progressStore?: ProgressStore;
  bundleHash?: string;
  providerHostManager: ProviderHostManager;
  launchCoordinator: LaunchCoordinator;
  eventBus: TypedEventBus;
  providerRegistry: ProviderRegistry;
};
type ClaimJobOptions = {
  expectedVersion?: number;
  initialPhase?: Extract<JobPhase, 'queued' | 'launching'>;
  jobKind?: JobKind;
};

function canAdvanceLaunchState(status: PersistedStatusRecord | null): status is PersistedStatusRecord {
  return status !== null && !isTerminalPhase(status.phase) && status.launch.state !== 'ready';
}

function rejectLaunch(code: string, message: string): LaunchDecision {
  return {
    status: 'rejected',
    phase: 'preflight',
    code,
    message,
  };
}

function resolveBackendNamespace(pluginRoot: string): string {
  try {
    return pluginRootNamespace(pluginRoot);
  } catch {
    return pluginRootNamespace(defaultPluginRoot);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isProviderContinuityBlob(value: unknown): value is ProviderContinuityBlob {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toProviderRequest(launchRecord: PersistedLaunchRecord): ProviderRequest {
  return {
    action: launchRecord.providerAction,
    sessionId: launchRecord.sessionId,
    name: launchRecord.request.name,
    prompt: launchRecord.request.prompt,
    conversationRef: launchRecord.request.conversationRef,
    model: launchRecord.request.model,
    cwd: launchRecord.request.cwd,
    effort: launchRecord.request.effort,
    bypassPermissions: launchRecord.request.bypassPermissions,
    systemPrompt: launchRecord.request.systemPrompt,
    instruction: launchRecord.request.instruction,
    coralEnv: launchRecord.request.coralEnv,
  };
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

async function runProviderPreflight(provider: Provider): Promise<string | null> {
  if (!provider.preflight) return null;
  try {
    await provider.preflight();
    return null;
  } catch (error: unknown) {
    return errorMessage(error);
  }
}

class SessionClaimError extends Error {
  constructor() {
    super('Session claim failed');
    this.name = 'SessionClaimError';
  }
}

/** Recovery-oriented interface for lifecycle startup/handoff/restart. */
export interface RecoveryCapableService {
  finalizeInterruptedAppServerJob(
    launchRecord: PersistedLaunchRecord,
    runtimeRecord: AppServerRuntimeRecord,
    context: { reason: 'restart' | 'handoff' },
  ): Promise<void>;
  adoptRunningJob(
    launchRecord: PersistedLaunchRecord,
    runtimeRecord: PersistedRuntimeRecord,
  ): { cleanup: () => void };
  recoverQueuedJob(launchRecord: PersistedLaunchRecord): string;
  interruptAppServerJob(
    launchRecord: PersistedLaunchRecord,
    runtimeRecord: AppServerRuntimeRecord,
  ): Promise<void>;
  completeRecoveredJob(
    jobId: string,
    sessionId: string,
    result: TerminalResult,
    phase: JobPhase,
    options?: { conversationRef?: string; nonResumable?: boolean },
  ): void;
}

export class ExecutionService implements RecoveryCapableService {
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

  constructor(ctx: CallerContext, deps: ExecutionServiceDeps) {
    this.projectRoot = ctx.projectRoot;
    this.eventBus = deps.eventBus;
    this.sessionManager = new SessionManager(ctx.projectRoot, this.eventBus);
    this.abortRegistry = new AbortRegistry();
    this.backendNamespace = resolveBackendNamespace(ctx.pluginRoot);
    this.bundleHash = deps.bundleHash ?? 'unknown';
    this.progressStore = deps.progressStore ?? new ProgressStore(this.eventBus);
    this.providerHostManager = deps.providerHostManager;
    this.launchCoordinator = deps.launchCoordinator;
    this.providerRegistry = deps.providerRegistry;
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

    const baseNotice =
      options.reason === 'restart' ? APP_SERVER_RESTART_NOTICE : APP_SERVER_HANDOFF_NOTICE;
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
          const lease = liveServer ? this.createAttachedProviderServerLease(liveServer) : await this.acquireServer(spec);
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
      reportConversationRef =
        mutation.type === 'set_resumable' ? mutation.conversationRef : preservedConversationRef;
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
      startTime: appRuntime?.startTime ?? new Date().toISOString(),
      providerMeta: {
        provider: providerName,
        leaseState: update.leaseState ?? appRuntime?.providerMeta.leaseState ?? 'waiting',
        serverGeneration: update.serverGeneration ?? appRuntime?.providerMeta.serverGeneration,
        providerContinuity:
          update.providerContinuity ?? appRuntime?.providerMeta.providerContinuity,
        recoveryPolicy: APP_SERVER_RECOVERY_POLICY,
      },
    };
    this.progressStore.writeRuntimeRecord(jobId, record);
  }

  private async claimAndAdmitJob(
    session: SessionEntry,
    providerName: string,
    projectRoot: string,
    sessionBusyMessage: string,
    expectedVersion: number = session.version,
    pool: LaunchPool = 'default',
  ): Promise<{ jobId: string; admission: AcceptedAdmission } | LaunchDecision> {
    const jobId = randomUUID();
    this.jobPools.set(jobId, pool);
    const admission = this.launchCoordinator.requestLaunch(jobId, providerName, pool);
    if (admission === 'queue_full') {
      this.jobPools.delete(jobId);
      return rejectLaunch('busy', QUEUE_FULL_MESSAGE);
    }

    const initialPhase: Extract<JobPhase, 'queued' | 'launching'> =
      admission.type === 'queued' ? 'queued' : 'launching';

    try {
      await this.claimJobAtomic(session, jobId, providerName, projectRoot, { expectedVersion, initialPhase });
    } catch (error: unknown) {
      if (admission.type === 'queued') {
        const waitForPermit = admission.waitForPermit();
        admission.cancel();
        void waitForPermit.catch((e: unknown) => { backendLog.warn(`Queued permit cleanup failed for ${jobId}: ${errorMessage(e)}`); });
      } else {
        this.launchCoordinator.releaseLaunch(jobId, pool);
      }
      this.jobPools.delete(jobId);

      if (error instanceof SessionClaimError) {
        return rejectLaunch('session_busy', sessionBusyMessage);
      }
      throw error;
    }

    return { jobId, admission };
  }

  private launchProviderJob(
    provider: Provider,
    sessionId: string,
    jobId: string,
    request: ProviderRequest,
    admission: AcceptedAdmission,
    pool: LaunchPool = 'default',
    projectRoot?: string,
    parentWorkflowJobId?: string,
  ): LaunchDecision {
    this.abortRegistry.register(jobId);

    // Write durable launch record before queue admission / execution
    this.progressStore.writeLaunchRecord(jobId, {
      jobId,
      sessionId,
      provider: provider.name,
      projectRoot: projectRoot ?? request.cwd ?? '',
      backendNamespace: this.backendNamespace,
      bundleHash: this.bundleHash,
      pool,
      enqueueSequence: this.progressStore.nextEnqueueSequence(),
      providerAction: request.action,
      request: {
        prompt: request.prompt,
        name: request.name,
        model: request.model,
        cwd: request.cwd,
        effort: request.effort,
        bypassPermissions: request.bypassPermissions,
        systemPrompt: request.systemPrompt,
        conversationRef: request.conversationRef,
        instruction: request.instruction,
        coralEnv: request.coralEnv,
      },
      parentWorkflowJobId,
      createdAt: new Date().toISOString(),
    });

    const decisionStatus = admission.type === 'queued' ? 'queued' : 'running';
    if (admission.type === 'queued') {
      this.markJobQueued(jobId, sessionId, admission.queuePosition);
    }

    this.runAsync(provider, sessionId, jobId, request, admission, pool);
    return { status: decisionStatus, job: jobId, session: sessionId };
  }

  async start(providerName: string, input: ExecInput, ctx: CallerContext): Promise<LaunchDecision> {
    const provider = this.providerRegistry.get(providerName);
    if (!provider) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

    const preflightError = await runProviderPreflight(provider);
    if (preflightError) return rejectLaunch('preflight_failed', preflightError);

    const cwd = input.cwd ?? ctx.projectRoot;
    const name = input.name ?? `session-${Date.now()}`;
    const model = input.model ?? 'unknown';
    const pool = input.pool ?? 'default';

    const session = this.sessionManager.allocate(providerName, name, model, cwd, ctx.projectRoot);
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
      name: input.name,
      prompt: input.prompt,
      model: input.model,
      cwd,
      effort: input.effort,
      bypassPermissions: input.bypassPermissions ?? false,
      systemPrompt: input.systemPrompt,
      instruction: input.instruction,
      coralEnv: ctx.coralEnv,
    };

    return this.launchProviderJob(
      provider,
      session.sessionId,
      admitted.jobId,
      request,
      admitted.admission,
      pool,
      ctx.projectRoot,
      input.parentWorkflowJobId,
    );
  }

  async resume(providerName: string, input: ResumeInput, ctx: CallerContext): Promise<LaunchDecision> {
    const provider = this.providerRegistry.get(providerName);
    if (!provider) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

    const busyMessage = `Session ${input.sessionId} already has an active job. Wait for it to complete or abort it first.`;
    const session = this.sessionManager.get(providerName, input.sessionId);
    if (!session)
      return rejectLaunch(
        'session_not_found',
        `Session not found: ${input.sessionId}. Use exec to start a new session.`,
      );
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

    const request: ProviderRequest = {
      action: 'resume',
      sessionId: session.sessionId,
      prompt: input.prompt,
      conversationRef: session.conversationRef,
      model: input.model,
      cwd: input.cwd ?? session.cwd,
      effort: input.effort,
      bypassPermissions: input.bypassPermissions ?? false,
      systemPrompt: input.systemPrompt,
      instruction: input.instruction,
      coralEnv: ctx.coralEnv,
    };

    return this.launchProviderJob(
      provider,
      session.sessionId,
      admitted.jobId,
      request,
      admitted.admission,
      pool,
      ctx.projectRoot,
      input.parentWorkflowJobId,
    );
  }

  async fork(providerName: string, input: ForkInput, ctx: CallerContext): Promise<LaunchDecision> {
    const provider = this.providerRegistry.get(providerName);
    if (!provider) return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);

    const sourceBusyMessage = `Session ${input.sessionId} already has an active job. Wait for it to complete or abort it first.`;
    const sourceSession = this.sessionManager.get(providerName, input.sessionId);
    if (!sourceSession)
      return rejectLaunch(
        'session_not_found',
        `Session not found: ${input.sessionId}. Use exec to start a new session.`,
      );
    if (sourceSession.activeJobId) {
      return rejectLaunch('session_busy', sourceBusyMessage);
    }
    const sourceExpectedVersion = sourceSession.version;

    const preflightError = await runProviderPreflight(provider);
    if (preflightError) return rejectLaunch('preflight_failed', preflightError);

    const sourceClaimId = randomUUID();
    const sourceClaimed = await this.sessionManager.claimForJobAtomic(
      sourceSession.sessionId,
      sourceClaimId,
      sourceExpectedVersion,
    );
    if (!sourceClaimed) {
      return rejectLaunch('session_busy', sourceBusyMessage);
    }

    try {
      const name = input.name ?? `fork-${Date.now()}`;
      const model = input.model ?? sourceSession.model;
      const cwd = input.cwd ?? sourceSession.cwd;
      const newSession = this.sessionManager.allocate(providerName, name, model, cwd, ctx.projectRoot);
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
        model: input.model,
        cwd,
        effort: input.effort,
        bypassPermissions: input.bypassPermissions ?? false,
        systemPrompt: input.systemPrompt,
        instruction: input.instruction,
        coralEnv: ctx.coralEnv,
      };

      return this.launchProviderJob(
        provider,
        newSession.sessionId,
        admitted.jobId,
        request,
        admitted.admission,
        'default',
        ctx.projectRoot,
      );
    } finally {
      this.sessionManager.releaseJob(sourceSession.sessionId, sourceClaimId);
    }
  }

  async coralDispatch(
    providerName: string,
    coralName: string,
    input: CoralInput,
    ctx: CallerContext,
  ): Promise<LaunchDecision> {
    const { content } = resolveCoralContent(coralName);
    const meta = parseAgentMeta(content);
    const stripped = stripAgentMetadata(content);
    const instruction = buildCoralInstruction(stripped);

    const model = meta.model;
    const effort = input.effort;
    const cwd = input.cwd ?? ctx.projectRoot;

    if (input.sessionId) {
      return this.resume(
        providerName,
        {
          sessionId: input.sessionId,
          prompt: input.prompt,
          name: coralName,
          model,
          cwd,
          effort,
          bypassPermissions: true,
          instruction,
          parentWorkflowJobId: input.parentWorkflowJobId,
        },
        ctx,
      );
    }

    return this.start(
      providerName,
      {
        prompt: input.prompt,
        name: `${coralName}-${Date.now()}`,
        model,
        cwd,
        effort,
        bypassPermissions: true,
        instruction,
        parentWorkflowJobId: input.parentWorkflowJobId,
      },
      ctx,
    );
  }

  async executeWorkflow(
    providerName: string,
    ast: PipelineAST,
    input: WorkflowInput,
    ctx: CallerContext,
    workDir?: string,
  ): Promise<LaunchDecision> {
    if (!this.providerRegistry.get(providerName)) {
      return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);
    }

    const session = this.sessionManager.allocate(
      providerName,
      `workflow-${Date.now()}`,
      'workflow',
      ctx.projectRoot,
      ctx.projectRoot,
    );
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
    const initialStatus = this.progressStore.readStatus(jobId);
    if (!initialStatus) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const owner = {
      provider: initialStatus.provider,
      sessionId: initialStatus.sessionId,
    };
    const timeoutError = new Error(
      `Timed out waiting for job ${jobId} to reach a terminal state and release its session`,
    );

    const isTerminalAndReleased = (status: PersistedStatusRecord): boolean => {
      if (!isTerminalPhase(status.phase)) {
        return false;
      }

      const session = this.sessionManager.get(owner.provider, owner.sessionId);
      return session?.activeJobId !== jobId;
    };

    const readTerminalAndReleased = (): boolean => {
      const status = this.progressStore.readStatus(jobId);
      if (!status) {
        throw new Error(`Job not found: ${jobId}`);
      }
      return isTerminalAndReleased(status);
    };

    if (isTerminalAndReleased(initialStatus)) {
      return;
    }

    const startedAt = Date.now();
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let settled = false;

      const cleanup = (): void => {
        this.eventBus.off('job:completed', onJobCompleted);
        this.eventBus.off('job:phase_changed', onJobPhaseChanged);
        this.eventBus.off('session:updated', onSessionUpdated);
        if (timer) clearTimeout(timer);
      };

      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };

      const recheck = (): void => {
        try {
          if (!readTerminalAndReleased()) {
            return;
          }
          finish(resolve);
        } catch (error: unknown) {
          finish(() => reject(error));
        }
      };

      const onJobCompleted = ({ jobId: completedJobId }: { jobId: string }): void => {
        if (completedJobId !== jobId) {
          return;
        }
        recheck();
      };

      const onJobPhaseChanged = ({ jobId: changedJobId }: { jobId: string }): void => {
        if (changedJobId !== jobId) {
          return;
        }
        recheck();
      };

      const onSessionUpdated = ({ sessionId }: { sessionId: string }): void => {
        if (sessionId !== owner.sessionId) {
          return;
        }
        recheck();
      };

      this.eventBus.on('job:completed', onJobCompleted);
      this.eventBus.on('job:phase_changed', onJobPhaseChanged);
      this.eventBus.on('session:updated', onSessionUpdated);

      recheck();
      if (settled) {
        return;
      }

      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        finish(() => reject(timeoutError));
        return;
      }

      timer = setTimeout(() => {
        finish(() => reject(timeoutError));
      }, remainingMs);
    });
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
      this.runRecoveredQueuedJob(provider, launchRecord, queuedHandle, pool);
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
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already dead */
      }
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
    const start = Date.now();
    while (true) {
      const seq = this.progressStore.getChangeSeq();
      const status = this.progressStore.readStatus(jobId);
      if (status && status.launch.state !== 'pending') return status.launch.state;

      const remainingMs = timeoutMs - (Date.now() - start);
      if (remainingMs <= 0) return 'pending';
      await Promise.race([
        this.progressStore.waitForChange(seq),
        new Promise<void>((resolve) => setTimeout(resolve, remainingMs)),
      ]);
    }
  }

  /** Async generator yielding queued/progress/terminal/timeout events for monitored jobs. */
  async *waitStream(req: WaitRequest): AsyncGenerator<WaitStreamEvent> {
    const { jobIds, timeoutSeconds = 600, cursor } = req;
    const startMs = Date.now();
    const timeoutMs = timeoutSeconds * 1000;

    const fromEventIds: Record<string, number> = cursor?.jobs ? { ...cursor.jobs } : {};
    const fileCursors = new Map(jobIds.map((id) => [id, createReplayCursor()]));
    const emittedQueued = new Set<string>();
    const pending = new Set(jobIds);

    while (pending.size > 0) {
      if (Date.now() - startMs >= timeoutMs) {
        yield { type: 'timeout', runningJobIds: [...pending] };
        return;
      }

      const seq = this.progressStore.getChangeSeq();

      for (const jobId of [...pending]) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- fileCursors initialized from same jobIds as pending
        const fileCursor = fileCursors.get(jobId)!;
        const fromEventId = fromEventIds[jobId] ?? 0;
        const status = this.progressStore.readStatus(jobId);
        if (!status) continue;

        const sessionId = status.sessionId;
        const pool = this.jobPools.get(jobId) ?? 'default';
        if (status.phase === 'queued' && !emittedQueued.has(jobId)) {
          emittedQueued.add(jobId);
          yield {
            type: 'queued',
            jobId,
            sessionId,
            queuePosition: this.launchCoordinator.queuePosition(jobId, pool) ?? 0,
            runningJobIds: this.launchCoordinator.getActiveJobIds(pool),
          };
        }
        const events = this.progressStore.replayFrom(jobId, fromEventId, fileCursor);

        for (const event of events) {
          fromEventIds[jobId] = event.eventId;

          if (event.type === 'progress') {
            yield {
              type: 'progress',
              jobId,
              sessionId,
              eventId: event.eventId,
              message: event.message ?? '',
            };
          } else if (event.type === 'terminal') {
            const remainingJobIds = jobIds.filter((id) => id !== jobId && pending.has(id));
            yield {
              type: 'terminal',
              completedJobId: jobId,
              sessionId,
              remainingJobIds,
              resultPath: jobResultPath(jobId),
              result: event.result ?? { content: '' },
            };
            pending.delete(jobId);
            break;
          }
        }

        const currentStatus = this.progressStore.readStatus(jobId);
        if (pending.has(jobId) && currentStatus && isTerminalPhase(currentStatus.phase)) {
          const remainingJobIds = jobIds.filter((id) => id !== jobId && pending.has(id));
          yield {
            type: 'terminal',
            completedJobId: jobId,
            sessionId: currentStatus.sessionId,
            remainingJobIds,
            resultPath: jobResultPath(jobId),
            result: currentStatus.result ?? { content: '' },
          };
          pending.delete(jobId);
        }
      }

      if (pending.size > 0) {
        const remainingMs = timeoutMs - (Date.now() - startMs);
        if (remainingMs <= 0) continue;
        await Promise.race([
          this.progressStore.waitForChange(seq),
          new Promise<void>((resolve) => setTimeout(resolve, remainingMs)),
        ]);
      }
    }
  }

  async waitStreamOnce(jobId: string, timeoutMs?: number): Promise<{ content: string; nonResumable: boolean }> {
    const request: WaitRequest = { jobIds: [jobId] };
    if (timeoutMs !== undefined) {
      request.timeoutSeconds = timeoutMs / 1000;
    }

    for await (const event of this.waitStream(request)) {
      if (event.type === 'terminal' && event.completedJobId === jobId) {
        return {
          content: event.result.content,
          nonResumable: event.result.nonResumable ?? false,
        };
      }
      if (event.type === 'timeout') {
        throw new Error('Job timed out waiting for terminal result');
      }
    }

    throw new Error(`Job ${jobId} ended without a terminal result`);
  }

  private runAsync(
    provider: Provider,
    sessionId: string,
    jobId: string,
    request: ProviderRequest,
    admission: AcceptedAdmission,
    pool: LaunchPool,
  ): void {
    const signal = this.abortRegistry.getSignal(jobId);
    if (!signal) {
      if (admission.type === 'queued') admission.cancel();
      else this.launchCoordinator.releaseLaunch(jobId, pool);
      return;
    }

    void (async () => {
      let permitAcquired = admission.type === 'immediate';

      try {
        if (admission.type === 'queued') {
          const queueOutcome = await this.waitForQueuedPermit(admission, signal);
          if (queueOutcome === 'aborted') {
            this.finishQueuedAbort(jobId, sessionId, QUEUED_ABORT_MESSAGE);
            return;
          }

          permitAcquired = true;
          this.markJobLaunching(jobId);
          this.progressStore.appendProgress(jobId, sessionId, 'dequeued, launching');
        }

        this.launchCoordinator.bindLaunchPermit(jobId, signal, pool);
        await this.executeProviderJob(provider, request, jobId, sessionId, signal, pool);
      } catch (err: unknown) {
        this.handleProviderJobError(jobId, sessionId, signal, err);
      } finally {
        if (permitAcquired) this.launchCoordinator.releaseLaunch(jobId, pool);
      }
    })();
  }

  /**
   * Async execution path for a recovered queued job.
   * Similar to `runAsync` but starts from a persisted launch record rather
   * than a freshly admitted request.
   */
  private runRecoveredQueuedJob(
    provider: Provider,
    launchRecord: PersistedLaunchRecord,
    admission: QueuedHandle,
    pool: LaunchPool,
  ): void {
    const jobId = launchRecord.jobId;
    const sessionId = launchRecord.sessionId;
    const signal = this.abortRegistry.getSignal(jobId);
    if (!signal) {
      admission.cancel();
      return;
    }

    void (async () => {
      try {
        const queueOutcome = await this.waitForQueuedPermit(admission, signal);
        if (queueOutcome === 'aborted') {
          this.finishQueuedAbort(jobId, sessionId, QUEUED_ABORT_MESSAGE);
          return;
        }

        this.markJobLaunching(jobId);
        this.progressStore.appendProgress(jobId, sessionId, 'dequeued, launching');

        this.launchCoordinator.bindLaunchPermit(jobId, signal, pool);
        const request = toProviderRequest(launchRecord);
        await this.executeProviderJob(provider, request, jobId, sessionId, signal, pool);
      } catch (err: unknown) {
        this.handleProviderJobError(jobId, sessionId, signal, err);
      } finally {
        this.launchCoordinator.releaseLaunch(jobId, pool);
      }
    })();
  }

  private async executeProviderJob(
    provider: Provider,
    request: ProviderRequest,
    jobId: string,
    sessionId: string,
    signal: AbortSignal,
    pool: LaunchPool,
  ): Promise<void> {
    const onEvent = (event: ProviderProgressEvent): void => {
      const currentStatus = this.progressStore.readStatus(jobId);
      if (canAdvanceLaunchState(currentStatus)) {
        this.markJobRunning(jobId);
      }
      this.progressStore.appendProgress(jobId, sessionId, event.message);
    };

    try {
      const runtime = this.createProviderRuntime(provider.name, sessionId, jobId, signal, pool, onEvent);
      const result = await provider.execute(request, runtime);

      if (canAdvanceLaunchState(this.progressStore.readStatus(jobId))) {
        this.markJobReady(jobId);
      }

      const phase: JobPhase = result.aborted ? 'aborted' : 'completed';
      const terminalResult: TerminalResult = {
        content: result.content,
        durationMs: result.durationMs,
        aborted: result.aborted,
        nonResumable: result.nonResumable,
        exitCode: result.exitCode,
        notice: result.notice,
        errors: result.errors,
        warnings: result.warnings,
        usage: result.usage,
      };

      const currentStatus = this.progressStore.readStatus(jobId);
      if (currentStatus && isTerminalPhase(currentStatus.phase)) {
        return;
      }

      this.writeTerminalResult(jobId, sessionId, terminalResult, phase);
      this.progressStore.writeResultMd(jobId, result.content);
      this.abortRegistry.remove(jobId);
      this.jobPools.delete(jobId);
      await this.finalizeProviderSession(provider.name, request, sessionId, jobId, result);
    } catch (err: unknown) {
      this.handleProviderJobError(jobId, sessionId, signal, err);
    }
  }

  private handleProviderJobError(
    jobId: string,
    sessionId: string,
    signal: AbortSignal,
    err: unknown,
  ): void {
    const currentStatus = this.progressStore.readStatus(jobId);
    if (!currentStatus || isTerminalPhase(currentStatus.phase)) {
      return;
    }

    if (err instanceof CliBusyError) {
      this.failJob(jobId, sessionId, 'busy', err.message);
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    if (signal.aborted || isAbortError(err)) {
      this.finishAbortedJob(jobId, sessionId, message);
      return;
    }
    this.failJob(jobId, sessionId, 'error', message);
  }

  private markJobQueued(jobId: string, sessionId: string, queuePosition: number): void {
    this.progressStore.updateLaunchState(jobId, 'queued');
    this.progressStore.appendProgress(jobId, sessionId, `queued (position ${queuePosition})`);
  }

  private createProviderRuntime(
    providerName: string,
    sessionId: string,
    jobId: string,
    signal: AbortSignal,
    pool: LaunchPool,
    onEvent: (event: ProviderProgressEvent) => void,
  ): ProviderRuntime {
    return {
      signal,
      onEvent,
      runCli: bindProviderRunner(
        this.launchCoordinator,
        providerName,
        signal,
        pool,
        this.progressStore.jobDir(jobId),
      ),
      acquireServer: (spec) => this.acquireServer(spec, { jobId, signal }),
      persistedContinuity: this.sessionManager.get(providerName, sessionId)?.providerContinuity,
      checkpointRecovery: (update) => {
        this.checkpointRecovery(jobId, update);
      },
    };
  }

  private markJobLaunching(jobId: string): void {
    this.progressStore.updatePhase(jobId, 'launching');
  }

  private async waitForQueuedPermit(admission: QueuedHandle, signal: AbortSignal): Promise<'granted' | 'aborted'> {
    return new Promise<'granted' | 'aborted'>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        if (settled) return;
        settled = true;
        admission.cancel();
        cleanup();
        resolve('aborted');
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });
      admission
        .waitForPermit()
        .then(() => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve('granted');
        })
        .catch((error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private finishQueuedAbort(jobId: string, sessionId: string, message: string): void {
    this.finishAbortedJob(jobId, sessionId, message);
  }

  private markJobReady(jobId: string): void {
    this.progressStore.updateLaunchState(jobId, 'ready');
  }

  private markJobRunning(jobId: string): void {
    this.markJobReady(jobId);
    this.progressStore.updatePhase(jobId, 'running');
  }

  private failJob(jobId: string, sessionId: string, launchState: LaunchState, message: string): void {
    this.progressStore.updateLaunchState(jobId, launchState, message);
    this.writeTerminalResult(jobId, sessionId, { content: '', notice: message }, 'error');
    this.abortRegistry.remove(jobId);
    this.jobPools.delete(jobId);
    this.sessionManager.releaseJob(sessionId, jobId);
  }

  private finishAbortedJob(jobId: string, sessionId: string, message: string): void {
    this.progressStore.updateLaunchState(jobId, 'error', message);
    this.writeTerminalResult(jobId, sessionId, { content: '', aborted: true, notice: message }, 'aborted');
    this.abortRegistry.remove(jobId);
    this.jobPools.delete(jobId);
    this.sessionManager.releaseJob(sessionId, jobId);
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
    try {
      this.progressStore.appendTerminal(jobId, sessionId, result, phase);
    } catch {
      try {
        this.progressStore.markTerminalStatus(jobId, result, phase);
      } catch {
        /* best-effort terminal write */
      }
    }
  }

  private runWorkflowAsync(
    sessionId: string,
    jobId: string,
    providerName: string,
    ast: PipelineAST,
    input: WorkflowInput,
    ctx: CallerContext,
    workDir?: string,
  ): void {
    const signal = this.abortRegistry.getSignal(jobId);
    if (!signal) return;

    void executePipeline(ast, input.init_prompt, providerName, this, ctx, {
      atoms: input.atoms,
      context: input.context,
      workDir,
      signal,
      staleTimeoutMs: input.stale_timeout_seconds * 1000,
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
        const message = err instanceof Error ? err.message : String(err);
        const aborted = err instanceof WorkflowExecutionError ? err.aborted : signal.aborted;
        const phase: Extract<JobPhase, 'error' | 'aborted'> = aborted ? 'aborted' : 'error';
        const stepDetails = err instanceof WorkflowExecutionError ? err.stepDetails : [];

        try {
          const serialized = serializeWorkflowResult(stepDetails);
          const terminalResult: TerminalResult = aborted
            ? {
                content: '',
                aborted: true,
                notice: message,
                workflow: serialized.workflow,
              }
            : {
                content: '',
                notice: message,
                workflow: serialized.workflow,
              };
          this.finishWorkflowJob(sessionId, jobId, phase, terminalResult, serialized.markdown);
        } catch {
          const emptyResult: TerminalResult = aborted
            ? { content: '', aborted: true, notice: message, workflow: { steps: [] } }
            : { content: '', notice: message, workflow: { steps: [] } };
          this.finishWorkflowJob(sessionId, jobId, phase, emptyResult, '');
        }
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
      atoms?: Record<string, { instruction?: string }>;
      context?: string;
      workDir?: string;
      staleTimeoutMs?: number;
    },
  ): void {
    const checkpoint = this.progressStore.readWorkflowCheckpoint(jobId);
    if (!checkpoint) return;

    const signal = this.abortRegistry.getSignal(jobId);
    if (!signal) return;

    void resumePipeline(checkpoint, ast, providerName, this, ctx, {
      atoms: options.atoms,
      context: options.context,
      workDir: options.workDir,
      signal,
      staleTimeoutMs: options.staleTimeoutMs ?? 0,
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
        const message = err instanceof Error ? err.message : String(err);
        const aborted = err instanceof WorkflowExecutionError ? err.aborted : signal.aborted;
        const phase: Extract<JobPhase, 'error' | 'aborted'> = aborted ? 'aborted' : 'error';
        const stepDetailsList = err instanceof WorkflowExecutionError ? err.stepDetails : [];
        try {
          const serialized = serializeWorkflowResult(stepDetailsList);
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
      });
  }
}
