import { currentEventMetadata, withInvocationScope } from './invocation-scope.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { ExecutionServiceDeps, ListResult, ProjectRequestPort } from './contracts.js';
import type { LaunchPool } from '../jobs/contracts/admission.js';
import type { ProviderRecoveryAuthority, RecoveryCapableService } from '../jobs/reconcile/contracts.js';
import type {
  JobLaunchRequest,
  JobResumeRequest,
  ProviderSessionLaunchDecision,
  WorkflowLaunchDecision,
} from '../jobs/launch.js';
import type { AbortReason } from '../jobs/outcome.js';
import type { JobPhase } from '../jobs/phase.js';
import type { AppServerRuntime, JobLaunch, JobRuntime, JobTerminalInput, LaunchReadiness } from '../jobs/records.js';
import type { TerminalWriteOptions } from '../jobs/contracts/job-store.js';
import type { DurableCliRuntimeRecord } from '../runtime/durable-runtime.js';
import type { WaitStreamEvent, WaitStreamOnceResult, WaitStreamRequest } from '../jobs/wait.js';
import type { PipelineAST } from '../workflow/ast.js';
import type { WorkflowCommand } from '../workflow/input.js';
import type { AbortResult } from '../jobs/contracts/abort-registry.js';
import { AbortRegistry } from '../jobs/shell/abort-registry.js';
import { SessionManager } from '../sessions/shell.js';
import { LaunchOrchestrator } from '../jobs/shell/launch.js';
import { WaitCoordinator } from '../jobs/shell/wait.js';
import type { TypedEventBus } from './event-bus.js';
import { normalizeCoralIntent, type CoralIntent } from './services/execution-policies.js';
import { JobLaunchService } from './services/job-launch.js';
import { WorkflowExecutionService } from './services/workflow-execution.js';
import { JobAbortService } from './services/job-abort.js';
import { JobWaitService } from './services/job-wait.js';
import { RecoveryService } from './services/recovery/service.js';
import { recordProviderTerminal } from './services/terminal-materializer.js';

/**
 * Handoff quiesce port: the dying daemon calls this immediately before
 * provider-host drain, so subsequent transport closure cannot record provider
 * terminals or release admission/session claim for active app-server jobs.
 *
 * Implementations synchronously close admission, then may await only durability
 * operations already admitted to the handoff fence. They never await provider
 * work or start new persistence after the fence.
 */
export interface HandoffQuiescePort {
  quiesceAppServerJobsForHandoff(): Promise<void>;
}

export class ExecutionService implements RecoveryCapableService, ProjectRequestPort, HandoffQuiescePort {
  private readonly runtime: ExecutionServiceDeps['runtime'];
  private readonly sessionManager: SessionManager;
  private readonly abortRegistry: AbortRegistry;
  private readonly backendNamespace: string;
  private readonly bundleHash: string;
  private readonly progressStore: ExecutionServiceDeps['progressStore'];
  private readonly projectRoot: string;
  private readonly eventBus: TypedEventBus;
  private readonly jobPools = new Map<string, LaunchPool>();
  private readonly launchOrchestrator: LaunchOrchestrator;
  private readonly launchService: JobLaunchService;
  private readonly workflowService: WorkflowExecutionService;
  private readonly abortService: JobAbortService;
  private readonly waitService: JobWaitService;
  private readonly recoveryService: RecoveryService;
  private invocationCorrelationSeq = 0;

  constructor(ctx: InvocationContext, deps: ExecutionServiceDeps) {
    this.projectRoot = ctx.projectRoot;
    this.runtime = deps.runtime;
    this.eventBus = deps.eventBus;
    const coordinatorCommit = deps.coordinatorCommit;
    this.sessionManager = SessionManager.forProduction(
      ctx.projectRoot,
      deps.runtime,
      coordinatorCommit,
      (payload) => {
        this.eventBus.emit('session:released', payload);
      },
      { db: deps.progressStore.getDb() },
    );
    this.abortRegistry = new AbortRegistry(deps.runtime.ids);
    this.backendNamespace = deps.backendNamespace;
    this.bundleHash = deps.bundleHash ?? 'unknown';
    this.progressStore = deps.progressStore;

    this.launchOrchestrator = new LaunchOrchestrator({
      sessionManager: this.sessionManager,
      abortRegistry: this.abortRegistry,
      progressStore: this.progressStore,
      launchAdmission: deps.launchCoordinator,
      durableSpawner: deps.launchCoordinator,
      providerRegistry: deps.providerRegistry,
      runtime: this.runtime,
      coordinatorCommit,
      backendNamespace: this.backendNamespace,
      bundleHash: this.bundleHash,
      jobPools: this.jobPools,
      getEventMetadata: () => {
        try {
          return currentEventMetadata();
        } catch {
          return null;
        }
      },
      terminalMaterializer: { recordProviderTerminal },
    });
    const waitCoordinator = new WaitCoordinator({
      sessionManager: this.sessionManager,
      launchQueue: deps.launchCoordinator,
      eventBus: this.eventBus,
      jobPools: this.jobPools,
      time: this.runtime.time,
      loadJobProjectionDetail: deps.loadJobProjectionDetail,
      readJobEvents: deps.readJobEvents,
      aggregateWorkflowUsage: deps.aggregateWorkflowUsage,
      subscribeJobEvents: deps.subscribeJobEvents,
      getCurrentJournalSeq: deps.getCurrentJournalSeq,
      resultJobsRoot: this.runtime.paths.coral.exports.jobsRoot,
      ensureResultArtifact: (jobId) => this.progressStore.ensureResultArtifact(jobId),
      observeCarriers: deps.observeCarriers,
    });

    this.recoveryService = new RecoveryService({
      runtime: this.runtime,
      sessionManager: this.sessionManager,
      abortRegistry: this.abortRegistry,
      backendNamespace: this.backendNamespace,
      bundleHash: this.bundleHash,
      progressStore: this.progressStore,
      launchAdmission: deps.launchCoordinator,
      launchRecovery: deps.launchCoordinator,
      providerRegistry: deps.providerRegistry,
      jobPools: this.jobPools,
      launchOrchestrator: this.launchOrchestrator,
      childPrincipalRegistry: deps.childPrincipalRegistry,
      parentPrincipal: ctx.principal,
    });
    this.launchService = new JobLaunchService({
      runtime: this.runtime,
      sessionManager: this.sessionManager,
      backendNamespace: this.backendNamespace,
      bundleHash: this.bundleHash,
      providerRegistry: deps.providerRegistry,
      pluginRegistry: deps.pluginRegistry,
      progressStore: this.progressStore,
      launchOrchestrator: this.launchOrchestrator,
      childPrincipalRegistry: deps.childPrincipalRegistry,
    });
    this.waitService = new JobWaitService({
      runtime: this.runtime,
      waitCoordinator,
      loadJobProjectionDetail: deps.loadJobProjectionDetail,
      subscribeJobEvents: deps.subscribeJobEvents,
      getCurrentJournalSeq: deps.getCurrentJournalSeq,
    });
    this.workflowService = new WorkflowExecutionService({
      runtime: this.runtime,
      abortRegistry: this.abortRegistry,
      backendNamespace: this.backendNamespace,
      bundleHash: this.bundleHash,
      progressStore: this.progressStore,
      providerRegistry: deps.providerRegistry,
      coordinatorCommit,
      launchOrchestrator: this.launchOrchestrator,
      executionPort: {
        coralDispatch: (providerName, coralName, input, requestCtx) =>
          this.runWithInvocationScope(requestCtx, () =>
            this.dispatchCoralIntent(providerName, coralName, input as CoralIntent, requestCtx),
          ),
        resume: (providerName, input, requestCtx) =>
          this.runWithInvocationScope(requestCtx, () =>
            this.launchService.resume(providerName, input as JobResumeRequest, requestCtx),
          ),
        recordContinuationLease: (input) =>
          this.runWithInvocationScope(ctx, async () => {
            this.sessionManager.recordContinuationLease(input);
          }),
        clearContinuationLease: (input) =>
          this.runWithInvocationScope(ctx, () => this.sessionManager.clearContinuationLease(input)),
        abort: (jobIds) => this.abortService.abort(jobIds),
        awaitLaunch: (jobId, timeoutMs) => this.waitService.awaitLaunch(jobId, timeoutMs),
        waitStream: (req) => this.waitService.waitStream(req),
        waitForJobTerminal: (jobId, timeoutMs) => this.waitService.waitForJobTerminal(jobId, timeoutMs),
      },
    });
    this.abortService = new JobAbortService({
      abortRegistry: this.abortRegistry,
      progressStore: this.progressStore,
      launchAdmission: deps.launchCoordinator,
      jobPools: this.jobPools,
      launchOrchestrator: this.launchOrchestrator,
    });
  }

  private runWithInvocationScope<T>(ctx: InvocationContext, run: () => T): T {
    return withInvocationScope(
      {
        namespace: this.backendNamespace,
        project: ctx.projectRoot,
        correlationId: `${this.backendNamespace}:${this.projectRoot}:${++this.invocationCorrelationSeq}`,
      },
      run,
    );
  }

  private async dispatchCoralIntent(
    providerName: string,
    coralName: string,
    input: CoralIntent,
    ctx: InvocationContext,
  ): Promise<ProviderSessionLaunchDecision> {
    const normalized = normalizeCoralIntent(input);
    if ('status' in normalized) return normalized;
    return this.launchService.coralDispatch(providerName, coralName, normalized, ctx);
  }

  async start(
    providerName: string,
    input: JobLaunchRequest,
    ctx: InvocationContext,
  ): Promise<ProviderSessionLaunchDecision> {
    return this.runWithInvocationScope(ctx, async () => this.launchService.start(providerName, input, ctx));
  }

  async resume(
    providerName: string,
    input: JobResumeRequest,
    ctx: InvocationContext,
  ): Promise<ProviderSessionLaunchDecision> {
    return this.runWithInvocationScope(ctx, async () => this.launchService.resume(providerName, input, ctx));
  }

  async coralDispatch(
    providerName: string,
    coralName: string,
    input: CoralIntent,
    ctx: InvocationContext,
  ): Promise<ProviderSessionLaunchDecision> {
    return this.runWithInvocationScope(ctx, async () => this.dispatchCoralIntent(providerName, coralName, input, ctx));
  }

  async executeWorkflow(
    providerName: string,
    ast: PipelineAST,
    input: WorkflowCommand,
    ctx: InvocationContext,
    workDir?: string,
  ): Promise<WorkflowLaunchDecision> {
    return this.workflowService.executeWorkflow(providerName, ast, input, ctx, workDir);
  }

  list(providerName: string): ListResult {
    return this.launchService.list(providerName);
  }

  abort(jobIds: string[]): AbortResult {
    return this.abortService.abort(jobIds);
  }

  async waitForJobTerminal(jobId: string, timeoutMs?: number): Promise<void> {
    return this.waitService.waitForJobTerminal(jobId, timeoutMs);
  }

  recoverQueuedJob(authority: ProviderRecoveryAuthority): Promise<string> {
    return this.recoveryService.recoverQueuedJob(authority);
  }

  captureProviderRecoveryAuthority(
    launchRecord: JobLaunch,
  ): ReturnType<RecoveryService['captureProviderRecoveryAuthority']> {
    return this.recoveryService.captureProviderRecoveryAuthority(launchRecord);
  }

  finalizeProviderRecoveryBindingFailure(
    launchRecord: JobLaunch,
    failure: Parameters<RecoveryService['finalizeProviderRecoveryBindingFailure']>[1],
  ): ReturnType<RecoveryService['finalizeProviderRecoveryBindingFailure']> {
    return this.recoveryService.finalizeProviderRecoveryBindingFailure(launchRecord, failure);
  }

  adoptRunningJob(
    authority: ProviderRecoveryAuthority,
    runtimeRecord: JobRuntime,
  ): Promise<{ adopted: boolean; cleanup: () => void }> {
    return this.recoveryService.adoptRunningJob(authority, runtimeRecord);
  }

  completeRecoveredJob(
    jobId: string,
    sessionId: string,
    result: JobTerminalInput,
    phase: JobPhase,
    options: TerminalWriteOptions & { pool: LaunchPool },
  ): ReturnType<RecoveryService['completeRecoveredJob']> {
    return this.recoveryService.completeRecoveredJob(jobId, sessionId, result, phase, options);
  }

  async finalizeInterruptedDurableJob(
    authority: ProviderRecoveryAuthority,
    runtimeRecord: DurableCliRuntimeRecord,
    observation: Parameters<RecoveryCapableService['finalizeInterruptedDurableJob']>[2],
    fence: Parameters<RecoveryCapableService['finalizeInterruptedDurableJob']>[3],
  ): Promise<void> {
    return this.recoveryService.finalizeInterruptedDurableJob(authority, runtimeRecord, observation, fence);
  }

  async interruptAppServerJob(authority: ProviderRecoveryAuthority, runtimeRecord: AppServerRuntime): Promise<void> {
    return this.recoveryService.interruptAppServerJob(authority, runtimeRecord);
  }

  private finishQueuedAbort(jobId: string, sessionId: string, reason: AbortReason): void {
    this.abortService.finishQueuedAbort(jobId, sessionId, reason);
  }

  async finalizeInterruptedAppServerJob(
    authority: ProviderRecoveryAuthority,
    runtimeRecord: AppServerRuntime,
    context: Parameters<RecoveryCapableService['finalizeInterruptedAppServerJob']>[2],
  ): Promise<void> {
    return this.recoveryService.finalizeInterruptedAppServerJob(authority, runtimeRecord, context);
  }

  quiesceAppServerJobsForHandoff(): Promise<void> {
    return this.launchOrchestrator.quiesceAppServerJobsForHandoff();
  }

  async awaitLaunch(jobId: string, timeoutMs: number): Promise<LaunchReadiness> {
    return this.waitService.awaitLaunch(jobId, timeoutMs);
  }

  async *waitStream(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent> {
    yield* this.waitService.waitStream(req);
  }

  async waitStreamOnce(jobId: string, timeoutMs?: number): Promise<WaitStreamOnceResult> {
    return this.waitService.waitStreamOnce(jobId, timeoutMs);
  }
}
