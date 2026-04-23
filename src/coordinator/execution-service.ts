import { currentEventMetadata, withCallerContext } from './caller-context.js';
import type { CallerContext } from '../shared/request-context.js';
import type {
  ExecutionLaunchPool as LaunchPool,
  ExecutionServiceDeps,
  ListResult,
  ProjectRequestPort,
  RecoveryCapableService,
} from './contracts.js';
import type { AppServerRuntime, AbortReason, JobLaunch, JobPhase, JobRuntime, JobTerminal, LaunchDecision, LaunchState } from '../jobs/api.js';
import type { WaitStreamEvent, WaitStreamOnceResult, WaitStreamRequest } from '../jobs/wait.js';
import type { PipelineAST, WorkflowCommand, WorkflowSessionHandle } from '../workflow/api.js';
import type { AbortResult } from '../shared/execution-contracts.js';
import type { ProviderContinuityBlob, ProviderServerLease, ProviderServerSpec } from '../providers/contract.js';
import { AbortRegistry } from '../jobs/api.js';
import { SessionManager } from '../sessions/shell/store.js';
import { LaunchOrchestrator } from '../jobs/shell/launch.js';
import { WaitCoordinator } from '../jobs/shell/wait.js';
import { noopAppendEvents } from '../store/append.js';
import type { TypedEventBus } from './control.js';
import type { CoralIntent, ExecIntent, ForkIntent, ResumeIntent } from './services/execution-shared.js';
import { JobLaunchService } from './services/job-launch-service.js';
import { WorkflowExecutionService } from './services/workflow-execution-service.js';
import { JobAbortService } from './services/job-abort-service.js';
import { JobWaitService } from './services/job-wait-service.js';
import { RecoveryService } from './services/recovery-service.js';

export class ExecutionService implements RecoveryCapableService, ProjectRequestPort {
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
  private callerCorrelationSeq = 0;

  constructor(ctx: CallerContext, deps: ExecutionServiceDeps) {
    this.projectRoot = ctx.projectRoot;
    this.runtime = deps.runtime;
    this.eventBus = deps.eventBus;
    this.sessionManager = SessionManager.forProduction(
      ctx.projectRoot,
      deps.runtime,
      deps.appendEvents ?? noopAppendEvents,
      (payload) => {
        this.eventBus.emit('session:released', payload);
      },
    );
    this.abortRegistry = new AbortRegistry(deps.runtime.ids);
    this.backendNamespace = deps.backendNamespace;
    this.bundleHash = deps.bundleHash ?? 'unknown';
    this.progressStore = deps.progressStore;

    const appendEvents = deps.appendEvents ?? noopAppendEvents;
    this.launchOrchestrator = new LaunchOrchestrator({
      abortRegistry: this.abortRegistry,
      progressStore: this.progressStore,
      sessionManager: this.sessionManager,
      launchCoordinator: deps.launchCoordinator,
      runtime: this.runtime,
      backendNamespace: this.backendNamespace,
      bundleHash: this.bundleHash,
      jobPools: this.jobPools,
      appendEvents,
      getEventMetadata: () => {
        try {
          return currentEventMetadata();
        } catch {
          return null;
        }
      },
      acquireServer: (spec, options) => this.recoveryService.acquireServer(spec, options),
    });
    const waitCoordinator = new WaitCoordinator({
      progressStore: this.progressStore,
      sessionManager: this.sessionManager,
      launchCoordinator: deps.launchCoordinator,
      eventBus: this.eventBus,
      jobPools: this.jobPools,
      time: this.runtime.time,
      loadJobProjectionDetail: deps.loadJobProjectionDetail,
      readJobProgress: deps.readJobProgress,
      subscribeJobEvents: deps.subscribeJobEvents,
      getCurrentJournalSeq: deps.getCurrentJournalSeq,
    });

    this.recoveryService = new RecoveryService({
      runtime: this.runtime,
      sessionManager: this.sessionManager,
      abortRegistry: this.abortRegistry,
      backendNamespace: this.backendNamespace,
      bundleHash: this.bundleHash,
      progressStore: this.progressStore,
      providerHostManager: deps.providerHostManager,
      launchCoordinator: deps.launchCoordinator,
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
      progressStore: this.progressStore,
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
      appendEvents,
      launchOrchestrator: this.launchOrchestrator,
      executionPort: {
        coralDispatch: (providerName, coralName, input, requestCtx) =>
          this.runWithCallerContext(requestCtx, () =>
            this.launchService.coralDispatch(providerName, coralName, input as CoralIntent, requestCtx),
          ),
        resume: (providerName, input, requestCtx) =>
          this.runWithCallerContext(requestCtx, () =>
            this.launchService.resume(providerName, input as ResumeIntent, requestCtx),
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
      launchCoordinator: deps.launchCoordinator,
      jobPools: this.jobPools,
      launchOrchestrator: this.launchOrchestrator,
      interruptAppServerJob: (launchRecord, runtimeRecord) =>
        this.recoveryService.interruptAppServerJob(launchRecord, runtimeRecord),
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

  async start(providerName: string, input: ExecIntent, ctx: CallerContext): Promise<LaunchDecision> {
    return this.runWithCallerContext(ctx, async () => this.launchService.start(providerName, input, ctx));
  }

  async resume(providerName: string, input: ResumeIntent, ctx: CallerContext): Promise<LaunchDecision> {
    return this.runWithCallerContext(ctx, async () => this.launchService.resume(providerName, input, ctx));
  }

  async fork(providerName: string, input: ForkIntent, ctx: CallerContext): Promise<LaunchDecision> {
    return this.runWithCallerContext(ctx, async () => this.launchService.fork(providerName, input, ctx));
  }

  async resumeBySessionId(input: ResumeIntent, ctx: CallerContext): Promise<LaunchDecision> {
    return this.runWithCallerContext(ctx, async () => this.launchService.resumeBySessionId(input, ctx));
  }

  async forkBySessionId(input: ForkIntent, ctx: CallerContext): Promise<LaunchDecision> {
    return this.runWithCallerContext(ctx, async () => this.launchService.forkBySessionId(input, ctx));
  }

  async coralDispatch(
    providerName: string,
    coralName: string,
    input: CoralIntent,
    ctx: CallerContext,
  ): Promise<LaunchDecision> {
    return this.runWithCallerContext(ctx, async () => this.launchService.coralDispatch(providerName, coralName, input, ctx));
  }

  async executeWorkflow(
    providerName: string,
    ast: PipelineAST,
    input: WorkflowCommand,
    ctx: CallerContext,
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
    result: JobTerminal,
    phase: JobPhase,
    options?: {
      continuity?: {
        conversationRef: string | null;
        resumable: boolean;
        providerContinuity?: ProviderContinuityBlob;
      };
    },
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

  private finishQueuedAbort(
    jobId: string,
    sessionId: string,
    reason: AbortReason,
  ): void {
    this.abortService.finishQueuedAbort(jobId, sessionId, reason);
  }

  private finishWorkflowJob(
    sessionId: string,
    jobId: string,
    phase: Extract<JobPhase, 'completed' | 'error' | 'aborted'>,
    result: JobTerminal,
    markdown: string,
  ): void {
    this.workflowService.finishWorkflowJob(sessionId, jobId, phase, result, markdown);
  }

  async finalizeInterruptedAppServerJob(
    launchRecord: JobLaunch,
    runtimeRecord: AppServerRuntime,
    context: { reason: 'restart' | 'handoff' },
  ): Promise<void> {
    return this.recoveryService.finalizeInterruptedAppServerJob(launchRecord, runtimeRecord, context);
  }

  async awaitLaunch(jobId: string, timeoutMs: number): Promise<LaunchState> {
    return this.waitService.awaitLaunch(jobId, timeoutMs);
  }

  async *waitStream(req: WaitStreamRequest): AsyncGenerator<WaitStreamEvent> {
    yield* this.waitService.waitStream(req);
  }

  async waitStreamOnce(jobId: string, timeoutMs?: number): Promise<WaitStreamOnceResult> {
    return this.waitService.waitStreamOnce(jobId, timeoutMs);
  }
}
