import { committedExecutionRequest } from '../../jobs/execution-journal.js';
import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { nowIsoString } from '../../infra/time.js';
import { identifyDurableRequest, throwIfRequestAborted } from '../../runtime/request-lease-identity.js';
import {
  hasProviderScope,
  type InvocationContext,
  type ProviderInvocationContext,
} from '../../runtime/invocation-context.js';
import type { Runtime } from '../../runtime/ports.js';
import type { ProviderBindingCatalog } from '../../providers/catalog.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import type { CommitContext, CommitEventsFn } from '../../store/append.js';
import type { CanonicalWorkflowCommand } from '../../workflow/compile.js';
import type { CanonicalWorkDir } from '../../runtime/canonical-work-dir.js';
import type { PipelineAST } from '../../workflow/ast.js';
import { executePipeline } from '../../workflow/executor.js';
import { resolveDrainDeadlineMs } from '../../workflow/execution-constants.js';
import { resolveStaleAbortTimeoutMs } from '../../workflow/stale-recovery.js';
import {
  WorkflowExecutionError,
  type PipelineResult,
  type StepDetail,
  type WorkflowExecutionPort,
} from '../../workflow/execution-contract.js';
import { createWorkflowJournal } from '../../workflow/projections.js';
import { type WorkflowLaunchDecision, refuseLaunch } from '../../jobs/launch.js';
import type { AbortReason } from '../../jobs/outcome.js';
import type { JobAbortRegistryPort } from '../../jobs/contracts/abort-registry.js';
import type { WorkflowJobLifecyclePort } from '../../jobs/contracts/job-runner.js';
import type { ExecutionFinisher } from '../../jobs/finishing.js';
import { TerminalWriteError } from '../../jobs/terminal/write-error.js';
import { composeWorkflowFinalization } from './workflow-finalization.js';
import type { WorkflowFinalizationIntent } from '../../workflow/finalization.js';
import { workflowProviderNames } from '../../workflow/normalize.js';
import { buildWorkflowPlan } from '../../workflow/plan.js';
import { workflowPlanDeclaredEvent } from '../../workflow/events.js';
import { providerBindingFailureCode } from '../../providers/contracts/binding.js';

export interface WorkflowExecutionServiceDeps {
  runtime: Runtime;
  runningJobs: Set<string>;
  abortRegistry: JobAbortRegistryPort;
  backendNamespace: string;
  bundleHash: string;
  progressStore: JobProgressStore;
  providerRegistry: ProviderBindingCatalog;
  coordinatorCommit: CommitEventsFn;
  executionFinisher: ExecutionFinisher;
  currentJobEpochKey?: () => string | null;
  launchOrchestrator: WorkflowJobLifecyclePort;
  executionPort: WorkflowExecutionPort;
  admitTopLevelLaunch?: () => boolean;
}

export interface WorkflowLaunchRequest {
  providerName: string;
  ast: PipelineAST;
  input: CanonicalWorkflowCommand;
  ctx: InvocationContext;
  workDir: CanonicalWorkDir;
  signal?: AbortSignal;
}

interface ScopedWorkflowLaunchRequest extends WorkflowLaunchRequest {
  ctx: ProviderInvocationContext;
}

interface WorkflowExecutionContext extends ScopedWorkflowLaunchRequest {
  jobId: string;
  declaredPlan: ReturnType<typeof buildWorkflowPlan>;
}

export class WorkflowExecutionService {
  private readonly deps: WorkflowExecutionServiceDeps;
  constructor(deps: WorkflowExecutionServiceDeps) {
    this.deps = deps;
  }

  async executeWorkflow(request: WorkflowLaunchRequest): Promise<WorkflowLaunchDecision> {
    const { providerName, ast, ctx, signal } = request;
    throwIfRequestAborted(signal);
    if (!this.deps.providerRegistry.get(providerName)) {
      return refuseLaunch('unknown_provider', `Unknown provider: ${providerName}`);
    }
    if (!hasProviderScope(ctx)) {
      return refuseLaunch(
        'provider_scope_missing',
        'This workflow request has no provider scope. Start it again from a launch-capable client with the selected provider profile.',
      );
    }
    const decodedScope = this.deps.providerRegistry.decodeCompleteScope(
      ctx.providerScope,
      workflowProviderNames(ast, providerName),
    );
    if (!decodedScope.ok) {
      return refuseLaunch(
        providerBindingFailureCode(decodedScope.failure),
        this.deps.providerRegistry.renderBindingFailure(decodedScope.failure),
      );
    }
    return this.launchWorkflow({ ...request, ctx: { ...ctx, providerScope: decodedScope.value } });
  }

  private launchWorkflow(request: ScopedWorkflowLaunchRequest): WorkflowLaunchDecision {
    const { providerName, ast, signal } = request;
    const jobId = this.deps.abortRegistry.register(this.deps.runtime.ids.uuid(), 1);
    identifyDurableRequest(signal, { jobId });
    let execution: WorkflowExecutionContext;
    try {
      execution = { ...request, jobId, declaredPlan: buildWorkflowPlan(jobId, ast, { defaultProvider: providerName }) };
      if (this.deps.admitTopLevelLaunch?.() === false) {
        this.deps.abortRegistry.remove(jobId, 1);
        return refuseLaunch(
          'succession_admission_paused',
          'Launch admission is paused during succession. Retry shortly.',
        );
      }
      throwIfRequestAborted(signal);
      this.commitWorkflowLaunch(execution);
    } catch (error: unknown) {
      this.deps.abortRegistry.remove(jobId, 1);
      throw error;
    }
    this.deps.runningJobs.add(jobId);
    this.deps.launchOrchestrator.markJobRunning(jobId);
    this.runWorkflowAsync(execution);
    return {
      kind: 'workflow',
      status: 'running',
      jobId,
      workflowId: jobId,
      epochKey: this.deps.currentJobEpochKey?.() ?? ':memory:',
      ...committedExecutionRequest(this.deps.progressStore.getDb(), jobId, 1),
    };
  }

  private commitWorkflowLaunch(execution: WorkflowExecutionContext): void {
    const { jobId, declaredPlan, ctx, workDir } = execution;
    this.deps.progressStore.withExecutionAdmission(
      jobId,
      1,
      { projectRoot: ctx.projectRoot, workDir, jobKind: 'workflow' },
      () => {
        this.deps.progressStore.commit((c) => {
          c.append(workflowPlanDeclaredEvent(jobId, declaredPlan, ctx.providerScope));
          c.append({
            type: 'job.opened',
            stream: { kind: 'job', id: jobId },
            namespace: this.deps.backendNamespace,
            project: ctx.projectRoot,
            refs: { jobId, workflowId: jobId },
            body: {
              jobKind: 'workflow',
              owner: { kind: 'workflow', id: jobId },
              projectRoot: ctx.projectRoot,
              cwd: workDir,
              bypassPermissions: false,
              createdAt: nowIsoString(this.deps.runtime.time),
            },
          });
          this.appendWorkflowStart(c, execution);
          return undefined;
        });
      },
    );
  }

  private appendWorkflowStart<Scope>(c: CommitContext<Scope>, execution: WorkflowExecutionContext): void {
    const { jobId, input, ctx } = execution;
    c.append({
      type: 'job.execution.requested',
      stream: { kind: 'job', id: jobId },
      namespace: this.deps.backendNamespace,
      project: ctx.projectRoot,
      refs: { jobId, workflowId: jobId },
      body: {
        execution: 1,
        input: input.startPrompt,
        action: 'exec',
        pool: 'default',
        enqueueSequence: this.deps.progressStore.nextEnqueueSequence(),
        coralEnv: { ...ctx.coralEnv },
        backendNamespace: this.deps.backendNamespace,
        bundleHash: this.deps.bundleHash,
        createdAt: nowIsoString(this.deps.runtime.time),
      },
    });
    c.append({
      type: 'job.execution.started',
      stream: { kind: 'job', id: jobId },
      namespace: this.deps.backendNamespace,
      project: ctx.projectRoot,
      refs: { jobId, workflowId: jobId },
      body: {
        execution: 1,
        transport: 'workflow',
        startedAt: nowIsoString(this.deps.runtime.time),
      },
    });
  }

  private async finishWorkflowJob(jobId: string, intent: WorkflowFinalizationIntent): Promise<void> {
    const address = { jobId, execution: 1 };
    const completedAt = this.deps.runtime.time.now();
    await this.deps.executionFinisher.accept(address, (c) => {
      const status = this.deps.progressStore.readStatus(jobId);
      if (status === null || status.execution !== address.execution)
        throw new Error(`Workflow '${jobId}' has no requested execution.`);
      const namespace = status.backendNamespace ?? this.deps.backendNamespace;
      const project = status.projectRoot;
      const runtime = this.deps.progressStore.readRuntimeProjection(jobId);
      if (runtime?.transport !== 'workflow') {
        throw new Error(`Workflow '${jobId}' has no workflow runtime start.`);
      }
      const startedAt = Date.parse(runtime.startTime);
      if (!Number.isFinite(startedAt)) {
        throw new Error(`Workflow '${jobId}' has an invalid runtime start timestamp.`);
      }
      const durationMs = Math.max(0, completedAt - startedAt);

      composeWorkflowFinalization(c, jobId, intent, { execution: address.execution, namespace, project, durationMs });
      return undefined;
    });

    this.deps.runningJobs.delete(jobId);
    this.deps.abortRegistry.remove(jobId, address.execution);
    await this.deps.executionFinisher.finish(address);
    try {
      this.deps.progressStore.ensureResultArtifact(jobId);
    } catch (error: unknown) {
      backendLog.warn(`Writing terminal artifact failed for ${jobId}: ${errorMessage(error)}`);
    }
  }

  private runWorkflowAsync(execution: WorkflowExecutionContext): void {
    const { jobId, providerName, ast, input, ctx, declaredPlan, workDir } = execution;
    const signal = this.deps.abortRegistry.getSignal(jobId);
    if (!signal) {
      this.deps.runningJobs.delete(jobId);
      return;
    }

    void executePipeline(ast, input.startPrompt, providerName, this.deps.executionPort, ctx, {
      context: input.context,
      workDir,
      signal,
      onProgress: (message: string) => {
        this.deps.progressStore.appendProgress(jobId, message);
      },
      workflowJobId: jobId,
      declaredPlan,
      ids: this.deps.runtime.ids,
      journal: createWorkflowJournal({ commit: this.deps.coordinatorCommit }),
      time: this.deps.runtime.time,
      drainDeadlineMs: resolveDrainDeadlineMs(this.deps.runtime.env),
      staleAbortTimeoutMs: resolveStaleAbortTimeoutMs(this.deps.runtime.env),
    })
      .then(
        (result: PipelineResult) =>
          this.finishWorkflowJob(jobId, {
            outcome: 'completed',
            workflowJobId: jobId,
            finalOutput: result.finalOutput,
            stepDetails: result.stepDetails,
          }),
        (err: unknown) => this.handleWorkflowError(err, jobId),
      )
      .catch((error: unknown) => this.handleWorkflowFinalizationError(jobId, error));
  }

  private handleWorkflowError(err: unknown, jobId: string): Promise<void> {
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
    let intent: WorkflowFinalizationIntent;
    if (workflowError?.aborted === true || workflowError?.terminalOutcome?.kind === 'aborted') {
      intent = {
        outcome: 'aborted',
        workflowJobId: jobId,
        reason: this.abortReasonForWorkflowError(workflowError),
        stepDetails,
      };
    } else {
      intent = {
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
    }

    return this.finishWorkflowJob(jobId, intent);
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
