import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { nowIsoString } from '../../infra/time.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { Runtime } from '../../runtime/ports.js';
import type { ProviderCatalog } from '../../providers/catalog.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import type { SessionWorkflowPort } from '../../sessions/contracts.js';
import type { CommitEventsFn } from '../../store/append.js';
import { type WorkflowCommand } from '../../workflow/input.js';
import type { PipelineAST } from '../../workflow/ast.js';
import { executePipeline } from '../../workflow/executor.js';
import { resolveDrainDeadlineMs } from '../../workflow/execution-constants.js';
import { resolveStaleAbortTimeoutMs } from '../../workflow/stale-recovery.js';
import {
  WorkflowExecutionError,
  type PipelineResult,
  type StepDetail,
  type WorkflowSessionHandle,
} from '../../workflow/execution-contract.js';
import { createWorkflowJournal } from '../../workflow/projections.js';
import type { JobTerminalDiagnostics, JobTerminalInput } from '../../jobs/records.js';
import type { JobPhase } from '../../jobs/phase.js';
import type { LaunchDecision } from '../../jobs/launch.js';
import type { AbortReason } from '../../jobs/outcome.js';
import { writeResultArtifact } from '../../jobs/terminal/export.js';
import type { JobAbortRegistryPort } from '../../jobs/contracts/abort-registry.js';
import type { WorkflowJobLifecyclePort } from '../../jobs/contracts/job-runner.js';
import { TerminalWriteError } from '../../jobs/terminal/write-error.js';
import { rejectLaunch } from '../../jobs/launch.js';
import { SessionClaimError } from '../../jobs/session-claim.js';
import { dispatchWorkflowSessionCleanup, toArtifactCleanupRuntime } from '../workflow-cleanup.js';
import { buildSessionControllerProfile, claimJobAtomic, serializeWorkflowResult } from './execution-policies.js';
import { composeWorkflowFinalization } from './workflow-finalization.js';
import type { WorkflowExecutionPort } from '../../workflow/execution-contract.js';
import type { WorkflowFinalizationIntent } from '../../workflow/finalization.js';

export interface WorkflowExecutionServiceDeps {
  runtime: Runtime;
  sessionManager: SessionWorkflowPort;
  abortRegistry: JobAbortRegistryPort;
  backendNamespace: string;
  bundleHash: string;
  progressStore: JobProgressStore;
  providerRegistry: ProviderCatalog;
  coordinatorCommit: CommitEventsFn;
  launchOrchestrator: WorkflowJobLifecyclePort;
  executionPort: WorkflowExecutionPort;
}

export class WorkflowExecutionService {
  constructor(private readonly deps: WorkflowExecutionServiceDeps) {}

  async executeWorkflow(
    providerName: string,
    ast: PipelineAST,
    input: WorkflowCommand,
    ctx: InvocationContext,
    workDir?: string,
  ): Promise<LaunchDecision> {
    if (!this.deps.providerRegistry.get(providerName)) {
      return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);
    }

    const controllerProfile = buildSessionControllerProfile(ctx.coralEnv);
    const session = this.deps.sessionManager.allocate({
      provider: providerName,
      name: `workflow-${this.deps.runtime.time.now()}`,
      model: 'workflow',
      cwd: ctx.projectRoot,
      projectRoot: ctx.projectRoot,
      backendNamespace: this.deps.backendNamespace,
      ...(controllerProfile !== undefined ? { controllerProfile } : {}),
    });
    const jobId = this.deps.abortRegistry.register();

    try {
      await claimJobAtomic(
        {
          sessionManager: this.deps.sessionManager,
        },
        session,
        jobId,
        providerName,
        ctx.projectRoot,
        {
          expectedVersion: session.version,
          jobKind: 'workflow',
        },
      );
    } catch (error: unknown) {
      this.deps.abortRegistry.remove(jobId);
      if (error instanceof SessionClaimError) {
        return rejectLaunch('session_busy', 'Session is already running a job');
      }
      throw error;
    }

    const workflowLaunchCwd = workDir ?? ctx.projectRoot;
    this.deps.progressStore.appendLaunchRequested(jobId, {
      jobId,
      sessionId: session.sessionId,
      provider: providerName,
      projectRoot: ctx.projectRoot,
      backendNamespace: this.deps.backendNamespace,
      bundleHash: this.deps.bundleHash,
      jobKind: 'workflow',
      pool: 'default',
      enqueueSequence: this.deps.progressStore.nextEnqueueSequence(),
      providerAction: 'exec',
      request: {
        prompt: input.startPrompt,
        cwd: workflowLaunchCwd,
        bypassPermissions: false,
        coralEnv: { ...ctx.coralEnv },
      },
      createdAt: nowIsoString(this.deps.runtime.time),
    });
    this.deps.progressStore.commit((c) => {
      c.append({
        type: 'job.runtime.started',
        stream: { kind: 'job', id: jobId },
        namespace: this.deps.backendNamespace,
        project: ctx.projectRoot,
        refs: { jobId, sessionId: session.sessionId },
        bodyVersion: 1,
        body: {
          startedAt: nowIsoString(this.deps.runtime.time),
        },
      });
      return undefined;
    });
    this.deps.launchOrchestrator.markJobRunning(jobId);

    this.runWorkflowAsync(session.sessionId, jobId, providerName, ast, input, ctx, workDir);
    return { status: 'running', job: jobId, session: session.sessionId };
  }

  cleanupWorkflowSessions(sessions: readonly WorkflowSessionHandle[]): void {
    dispatchWorkflowSessionCleanup(sessions, {
      resolveConversationRef: (providerName, sessionId) =>
        this.deps.sessionManager.get(providerName, sessionId)?.conversationRef,
      get: (providerName) => this.deps.providerRegistry.get(providerName),
      cleanupRuntime: toArtifactCleanupRuntime(this.deps.runtime),
      onError: (message) => backendLog.warn(message),
    });
  }

  private commitWorkflowJobTerminal(sessionId: string, jobId: string, intent: WorkflowFinalizationIntent): void {
    const status = this.deps.progressStore.readStatus(jobId);
    const namespace = status?.backendNamespace ?? this.deps.backendNamespace;
    const project = status?.projectRoot;

    this.deps.coordinatorCommit((c) => {
      composeWorkflowFinalization(c, jobId, intent, { sessionId, namespace, project });
      return undefined;
    });
  }

  private finishWorkflowJobPostCommit(sessionId: string, jobId: string, markdown: string): void {
    try {
      writeResultArtifact(this.deps.runtime.storage, this.deps.runtime.paths.coral.exports.jobsRoot, jobId, markdown);
    } catch (error: unknown) {
      backendLog.warn(`Writing terminal artifact failed for ${jobId}: ${errorMessage(error)}`);
    }
    this.deps.sessionManager.setNonResumable(sessionId);
    this.deps.abortRegistry.remove(jobId);
    this.deps.sessionManager.releaseJob(sessionId, jobId);
  }

  finishWorkflowJob(
    sessionId: string,
    jobId: string,
    _phase: Extract<JobPhase, 'completed' | 'error' | 'aborted'>,
    result: JobTerminalInput,
    markdown: string,
    _diagnostics: JobTerminalDiagnostics = {},
  ): void {
    const intent = this.intentFromTerminalResult(jobId, result);
    this.commitWorkflowJobTerminal(sessionId, jobId, intent);
    this.finishWorkflowJobPostCommit(sessionId, jobId, markdown);
  }

  private runWorkflowAsync(
    sessionId: string,
    jobId: string,
    providerName: string,
    ast: PipelineAST,
    input: WorkflowCommand,
    ctx: InvocationContext,
    workDir?: string,
  ): void {
    const signal = this.deps.abortRegistry.getSignal(jobId);
    if (!signal) return;

    void executePipeline(ast, input.startPrompt, providerName, this.deps.executionPort, ctx, {
      context: input.context,
      workDir,
      signal,
      onProgress: (message: string) => {
        this.deps.progressStore.appendProgress(jobId, sessionId, message);
      },
      workflowJobId: jobId,
      journal: createWorkflowJournal({ commit: this.deps.coordinatorCommit }),
      time: this.deps.runtime.time,
      ids: this.deps.runtime.ids,
      drainDeadlineMs: resolveDrainDeadlineMs(this.deps.runtime.env),
      staleAbortTimeoutMs: resolveStaleAbortTimeoutMs(this.deps.runtime.env),
    }).then(
      (result: PipelineResult) => {
        const serialized = serializeWorkflowResult(result.stepDetails);
        try {
          this.commitWorkflowJobTerminal(sessionId, jobId, {
            outcome: 'completed',
            workflowJobId: jobId,
            finalOutput: result.finalOutput,
            stepDetails: result.stepDetails,
          });
          this.finishWorkflowJobPostCommit(sessionId, jobId, serialized.markdown);
        } catch (error: unknown) {
          this.handleWorkflowFinalizationError(jobId, error);
        }
      },
      (err: unknown) => {
        try {
          this.handleWorkflowError(err, sessionId, jobId);
        } catch (error: unknown) {
          this.handleWorkflowFinalizationError(jobId, error);
        }
      },
    );
  }

  private handleWorkflowError(err: unknown, sessionId: string, jobId: string): void {
    const message = errorMessage(err);
    const workflowError = err instanceof WorkflowExecutionError ? err : null;
    const stepDetails: StepDetail[] = err instanceof WorkflowExecutionError ? err.stepDetails : [];
    const failureLocation =
      workflowError === null
        ? undefined
        : (() => {
            const location = {
              ...(workflowError.failedSlotId === undefined ? {} : { slotId: workflowError.failedSlotId }),
              ...(workflowError.failedStep === undefined ? {} : { stepIndex: workflowError.failedStep }),
              ...(workflowError.failedAtom === undefined ? {} : { atomLabel: workflowError.failedAtom }),
              ...(workflowError.failedJobId === undefined ? {} : { jobId: workflowError.failedJobId }),
            };
            return Object.keys(location).length === 0 ? undefined : location;
          })();
    const intent: WorkflowFinalizationIntent =
      workflowError?.aborted === true || workflowError?.terminalOutcome?.kind === 'aborted'
        ? {
            outcome: 'aborted',
            workflowJobId: jobId,
            reason: this.abortReasonForWorkflowError(workflowError),
            stepDetails,
          }
        : {
            outcome: 'failed',
            workflowJobId: jobId,
            ...(workflowError?.causeRef === undefined ? {} : { causeRef: workflowError.causeRef }),
            lifecycleFault: {
              kind: 'wrapper_crashed',
              message,
              ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
            },
            stepDetails,
            ...(failureLocation === undefined ? {} : { failureLocation }),
          };

    const serialized = serializeWorkflowResult(stepDetails);
    this.commitWorkflowJobTerminal(sessionId, jobId, intent);
    this.finishWorkflowJobPostCommit(sessionId, jobId, serialized.markdown);
  }

  private intentFromTerminalResult(jobId: string, result: JobTerminalInput): WorkflowFinalizationIntent {
    switch (result.outcome.kind) {
      case 'completed':
        return {
          outcome: 'completed',
          workflowJobId: jobId,
          finalOutput: result.content,
          stepDetails: [],
        };
      case 'aborted':
        return {
          outcome: 'aborted',
          workflowJobId: jobId,
          reason: result.outcome.reason,
          stepDetails: [],
        };
      case 'failed':
        return {
          outcome: 'failed',
          workflowJobId: jobId,
          causeRef: result.outcome.causeRef,
          lifecycleFault: {
            kind: 'wrapper_crashed',
            message: 'Workflow failed.',
          },
          stepDetails: [],
        };
      case 'job_fault':
      case 'provider_exit':
        return {
          outcome: 'failed',
          workflowJobId: jobId,
          lifecycleFault: {
            kind: 'unknown',
            message: 'Workflow terminal outcome could not be classified.',
          },
          stepDetails: [],
        };
    }
  }

  private abortReasonForWorkflowError(error: WorkflowExecutionError): AbortReason {
    return error.terminalOutcome?.kind === 'aborted' ? error.terminalOutcome.reason : 'signal_abort';
  }

  private handleWorkflowFinalizationError(jobId: string, error: unknown): void {
    if (error instanceof TerminalWriteError) {
      backendLog.error(error.message, error.cause);
      return;
    }
    backendLog.error(`Failed to finalize workflow job ${jobId}: ${errorMessage(error)}`, error);
  }
}
