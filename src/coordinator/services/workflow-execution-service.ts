import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { nowIsoString } from '../../infra/time.js';
import type { InvocationContext } from '../../runtime/invocation-context.js';
import type { Runtime } from '../../runtime/ports.js';
import type { ProviderCatalog } from '../../providers/catalog.js';
import type { JobProgressStore } from '../../jobs/progress-store-contract.js';
import type { SessionManager } from '../../sessions/shell/store.js';
import type { AppendEventsFn } from '../../store/append.js';
import {
  type WorkflowCommand,
} from '../../workflow/input.js';
import type { PipelineAST } from '../../workflow/ast.js';
import { executePipeline } from '../../workflow/executor.js';
import {
  WorkflowExecutionError,
  type PipelineResult,
  type StepDetail,
  type WorkflowSessionHandle,
} from '../../workflow/internal/execution-contract.js';
import { createWorkflowJournal } from '../../workflow/projections.js';
import {
  type JobTerminalDiagnostics,
  type JobTerminalInput,
} from '../../jobs/records.js';
import type { JobPhase } from '../../jobs/phase.js';
import type { LaunchDecision } from '../../jobs/launch.js';
import type { TerminalOutcome } from '../../jobs/outcome.js';
import { writeWorkflowResult } from '../../jobs/shell/result-artifact.js';
import type { AbortRegistry } from '../../jobs/shell/abort-registry.js';
import type { LaunchOrchestrator } from '../../jobs/shell/launch.js';
import { SessionClaimError, rejectLaunch } from '../../jobs/shell/contracts.js';
import { dispatchWorkflowSessionCleanup, toArtifactCleanupRuntime } from '../workflow-cleanup.js';
import {
  buildSessionControllerProfile,
  claimJobAtomic,
  serializeWorkflowResult,
} from './execution-policies.js';
import type { WorkflowExecutionPort } from '../../workflow/internal/execution-contract.js';

export interface WorkflowExecutionServiceDeps {
  runtime: Runtime;
  sessionManager: SessionManager;
  abortRegistry: AbortRegistry;
  backendNamespace: string;
  bundleHash: string;
  progressStore: JobProgressStore;
  providerRegistry: ProviderCatalog;
  appendEvents: AppendEventsFn;
  launchOrchestrator: LaunchOrchestrator;
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
    this.deps.progressStore.writeLaunchRecord(jobId, {
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
    this.deps.progressStore.appendEvent({
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

  finishWorkflowJob(
    sessionId: string,
    jobId: string,
    phase: Extract<JobPhase, 'completed' | 'error' | 'aborted'>,
    result: JobTerminalInput,
    markdown: string,
    diagnostics: JobTerminalDiagnostics = {},
  ): void {
    this.deps.progressStore.writeWorkflowResultMdOrThrow(jobId, markdown);
    writeWorkflowResult(this.deps.runtime.storage, jobId, markdown);
    this.deps.launchOrchestrator.writeJobTerminal(jobId, sessionId, result, phase, { diagnostics });
    this.deps.sessionManager.setNonResumable(sessionId);
    this.deps.abortRegistry.remove(jobId);
    this.deps.sessionManager.releaseJob(sessionId, jobId);
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
      journal: createWorkflowJournal({ appendEvents: this.deps.appendEvents }),
    })
      .then((result: PipelineResult) => {
        const serialized = serializeWorkflowResult(result.stepDetails);
        this.finishWorkflowJob(
          sessionId,
          jobId,
          'completed',
          {
            content: result.finalOutput,
            outcome: { kind: 'completed' },
          },
          serialized.markdown,
          { workflow: serialized.workflow },
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
    const stepDetails: StepDetail[] = err instanceof WorkflowExecutionError ? err.stepDetails : [];
    const outcome: TerminalOutcome =
      workflowError?.terminalOutcome ??
      (aborted
        ? { kind: 'aborted', reason: 'signal_abort' }
        : { kind: 'job_fault', fault: { kind: 'wrapper_crashed', cause: { message } } });

    try {
      const serialized = serializeWorkflowResult(stepDetails);
      const terminalResult: JobTerminalInput = {
        content: '',
        outcome,
      };
      this.finishWorkflowJob(sessionId, jobId, 'error', terminalResult, serialized.markdown, {
        workflow: serialized.workflow,
      });
    } catch {
      const emptyResult: JobTerminalInput = {
        content: '',
        outcome,
      };
      this.finishWorkflowJob(sessionId, jobId, 'error', emptyResult, '', { workflow: { steps: [] } });
    }
  }
}
