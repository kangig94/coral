import { currentEventMetadata, withInvocationScope } from './invocation-scope.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { ExecutionServiceDeps, ListResult, ProjectRequestPort } from './contracts.js';
import type { LaunchPool } from '../jobs/contracts/admission.js';
import type { RecoveryCapableService } from '../jobs/reconcile/contracts.js';
import type { LaunchDecision, JobForkRequest, JobLaunchRequest, JobResumeRequest } from '../jobs/launch.js';
import type { AbortReason } from '../jobs/outcome.js';
import type { JobPhase } from '../jobs/phase.js';
import type {
  AppServerRuntime,
  JobLaunch,
  JobRuntime,
  JobTerminalDiagnostics,
  JobTerminalInput,
  LaunchReadiness,
} from '../jobs/records.js';
import type { TerminalWriteOptions } from '../jobs/contracts/job-store.js';
import type { WaitStreamEvent, WaitStreamOnceResult, WaitStreamRequest } from '../jobs/wait.js';
import type { PipelineAST } from '../workflow/ast.js';
import type { WorkflowCommand } from '../workflow/input.js';
import type { WorkflowSessionHandle } from '../workflow/execution-contract.js';
import type { AbortResult } from '../jobs/contracts/abort-registry.js';
import type { ProviderServerLease, ProviderServerSpec } from '../providers/contract.js';
import { AbortRegistry } from '../jobs/shell/abort-registry.js';
import { SessionManager } from '../sessions/shell.js';
import { LaunchOrchestrator } from '../jobs/shell/launch.js';
import { WaitCoordinator } from '../jobs/shell/wait.js';
import type { TypedEventBus } from './event-bus.js';
import type { CoralIntent } from './services/execution-policies.js';
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
 * Implementations MUST NOT contain awaits-that-can-hang — the contract is
 * synchronous-in-spirit so AC4's atomicity argument holds: detach must already
 * have completed before the budget timer fires.
 */
export interface HandoffQuiescePort {
  quiesceAppServerJobsForHandoff(signal: AbortSignal): Promise<void>;
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
    const coordinatorCommit = deps.coordinatorCommit ?? ((cb) => deps.progressStore.commit(cb));
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
      abortRegistry: this.abortRegistry,
      progressStore: this.progressStore,
      sessionManager: this.sessionManager,
      launchAdmission: deps.launchCoordinator,
      durableSpawner: deps.launchCoordinator,
      runtime: this.runtime,
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
      acquireServer: (spec, options) => this.recoveryService.acquireServer(spec, options),
    });
    const waitCoordinator = new WaitCoordinator({
      sessionManager: this.sessionManager,
      launchQueue: deps.launchCoordinator,
      eventBus: this.eventBus,
      jobPools: this.jobPools,
      time: this.runtime.time,
      loadJobProjectionDetail: deps.loadJobProjectionDetail,
      readJobEvents: deps.readJobEvents,
      subscribeJobEvents: deps.subscribeJobEvents,
      getCurrentJournalSeq: deps.getCurrentJournalSeq,
      resultJobsRoot: this.runtime.paths.coral.exports.jobsRoot,
      ensureResultArtifact: (jobId) => this.progressStore.ensureResultArtifact(jobId),
    });

    this.recoveryService = new RecoveryService({
      runtime: this.runtime,
      sessionManager: this.sessionManager,
      abortRegistry: this.abortRegistry,
      backendNamespace: this.backendNamespace,
      bundleHash: this.bundleHash,
      progressStore: this.progressStore,
      providerHostManager: deps.providerHostManager,
      launchAdmission: deps.launchCoordinator,
      launchRecovery: deps.launchCoordinator,
      providerRegistry: deps.providerRegistry,
      jobPools: this.jobPools,
      launchOrchestrator: this.launchOrchestrator,
      acquireServer: (spec, options) => this.acquireServer(spec, options),
    });
    this.launchService = new JobLaunchService({
      runtime: this.runtime,
      sessionManager: this.sessionManager,
      backendNamespace: this.backendNamespace,
      bundleHash: this.bundleHash,
      providerRegistry: deps.providerRegistry,
      pluginRegistry: deps.pluginRegistry,
      progressStore: this.progressStore,
      sessionLookup: deps.sessionLookup,
      launchOrchestrator: this.launchOrchestrator,
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
      sessionManager: this.sessionManager,
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
            this.launchService.coralDispatch(providerName, coralName, input as CoralIntent, requestCtx),
          ),
        resume: (providerName, input, requestCtx) =>
          this.runWithInvocationScope(requestCtx, () =>
            this.launchService.resume(providerName, input as JobResumeRequest, requestCtx),
          ),
        abort: (jobIds) => this.abortService.abort(jobIds),
        awaitLaunch: (jobId, timeoutMs) => this.waitService.awaitLaunch(jobId, timeoutMs),
        waitStream: (req) => this.waitService.waitStream(req),
        waitForJobTerminal: (jobId, timeoutMs) => this.waitService.waitForJobTerminal(jobId, timeoutMs),
        cleanupWorkflowSessions: (sessions) => this.workflowService.cleanupWorkflowSessions(sessions),
      },
    });
    this.abortService = new JobAbortService({
      abortRegistry: this.abortRegistry,
      progressStore: this.progressStore,
      launchAdmission: deps.launchCoordinator,
      jobPools: this.jobPools,
      launchOrchestrator: this.launchOrchestrator,
      interruptAppServerJob: (launchRecord, runtimeRecord) =>
        this.recoveryService.interruptAppServerJob(launchRecord, runtimeRecord),
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

  async start(providerName: string, input: JobLaunchRequest, ctx: InvocationContext): Promise<LaunchDecision> {
    return this.runWithInvocationScope(ctx, async () => this.launchService.start(providerName, input, ctx));
  }

  async resume(providerName: string, input: JobResumeRequest, ctx: InvocationContext): Promise<LaunchDecision> {
    return this.runWithInvocationScope(ctx, async () => this.launchService.resume(providerName, input, ctx));
  }

  async fork(providerName: string, input: JobForkRequest, ctx: InvocationContext): Promise<LaunchDecision> {
    return this.runWithInvocationScope(ctx, async () => this.launchService.fork(providerName, input, ctx));
  }

  async resumeBySessionId(input: JobResumeRequest, ctx: InvocationContext): Promise<LaunchDecision> {
    return this.runWithInvocationScope(ctx, async () => this.launchService.resumeBySessionId(input, ctx));
  }

  async forkBySessionId(input: JobForkRequest, ctx: InvocationContext): Promise<LaunchDecision> {
    return this.runWithInvocationScope(ctx, async () => this.launchService.forkBySessionId(input, ctx));
  }

  async coralDispatch(
    providerName: string,
    coralName: string,
    input: CoralIntent,
    ctx: InvocationContext,
  ): Promise<LaunchDecision> {
    return this.runWithInvocationScope(ctx, async () =>
      this.launchService.coralDispatch(providerName, coralName, input, ctx),
    );
  }

  async executeWorkflow(
    providerName: string,
    ast: PipelineAST,
    input: WorkflowCommand,
    ctx: InvocationContext,
    workDir?: string,
  ): Promise<LaunchDecision> {
    return this.workflowService.executeWorkflow(providerName, ast, input, ctx, workDir);
  }

  list(providerName: string): ListResult {
    return this.launchService.list(providerName);
  }

  cleanupWorkflowSessions(sessions: readonly WorkflowSessionHandle[]): void {
    this.workflowService.cleanupWorkflowSessions(sessions);
  }

  abort(jobIds: string[]): AbortResult {
    return this.abortService.abort(jobIds);
  }

  async waitForJobTerminal(jobId: string, timeoutMs?: number): Promise<void> {
    return this.waitService.waitForJobTerminal(jobId, timeoutMs);
  }

  recoverQueuedJob(launchRecord: JobLaunch): string {
    return this.recoveryService.recoverQueuedJob(launchRecord);
  }

  adoptRunningJob(launchRecord: JobLaunch, runtimeRecord: JobRuntime): { cleanup: () => void } {
    return this.recoveryService.adoptRunningJob(launchRecord, runtimeRecord);
  }

  completeRecoveredJob(
    jobId: string,
    sessionId: string,
    result: JobTerminalInput,
    phase: JobPhase,
    options?: TerminalWriteOptions,
  ): void {
    this.recoveryService.completeRecoveredJob(jobId, sessionId, result, phase, options);
  }

  async interruptAppServerJob(launchRecord: JobLaunch, runtimeRecord: AppServerRuntime): Promise<void> {
    return this.recoveryService.interruptAppServerJob(launchRecord, runtimeRecord);
  }

  async acquireServer(
    spec: ProviderServerSpec,
    options?: { jobId?: string; signal?: AbortSignal },
  ): Promise<ProviderServerLease> {
    return this.recoveryService.acquireServer(spec, options);
  }

  private finishQueuedAbort(jobId: string, sessionId: string, reason: AbortReason): void {
    this.abortService.finishQueuedAbort(jobId, sessionId, reason);
  }

  private finishWorkflowJob(
    sessionId: string,
    jobId: string,
    phase: Extract<JobPhase, 'completed' | 'error' | 'aborted'>,
    result: JobTerminalInput,
    markdown: string,
    diagnostics?: JobTerminalDiagnostics,
  ): void {
    this.workflowService.finishWorkflowJob(sessionId, jobId, phase, result, markdown, diagnostics);
  }

  async finalizeInterruptedAppServerJob(
    launchRecord: JobLaunch,
    runtimeRecord: AppServerRuntime,
    context: { reason: 'restart' | 'handoff' },
  ): Promise<void> {
    return this.recoveryService.finalizeInterruptedAppServerJob(launchRecord, runtimeRecord, context);
  }

  quiesceAppServerJobsForHandoff(signal: AbortSignal): Promise<void> {
    return this.launchOrchestrator.quiesceAppServerJobsForHandoff(signal);
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
