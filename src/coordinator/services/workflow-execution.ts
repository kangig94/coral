import { backendLog } from '../../infra/backend-log.js';
import { errorMessage } from '../../infra/error-format.js';
import { nowIsoString } from '../../infra/time.js';
import { hasProviderScope, type InvocationContext } from '../../runtime/invocation-context.js';
import type { Runtime } from '../../runtime/ports.js';
import type { ProviderBindingCatalog } from '../../providers/catalog.js';
import type { JobProgressStore } from '../../jobs/contracts/job-store.js';
import type { CommitEventsFn } from '../../store/append.js';
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
import { type WorkflowLaunchDecision, rejectLaunch } from '../../jobs/launch.js';
import type { AbortReason } from '../../jobs/outcome.js';
import { writeWorkflowResultArtifact } from '../../workflow/result-artifact.js';
import type { JobAbortRegistryPort } from '../../jobs/contracts/abort-registry.js';
import type { WorkflowJobLifecyclePort } from '../../jobs/contracts/job-runner.js';
import { TerminalWriteError } from '../../jobs/terminal/write-error.js';
import { serializeWorkflowResult } from './execution-policies.js';
import { composeWorkflowFinalization } from './workflow-finalization.js';
import type { WorkflowFinalizationIntent } from '../../workflow/finalization.js';
import { workflowProviderNames } from '../../workflow/normalize.js';
import { buildWorkflowPlan } from '../../workflow/plan.js';
import { workflowPlanDeclaredEvent } from '../../workflow/events.js';
import { providerBindingFailureCode } from '../../providers/contracts/binding.js';

export interface WorkflowExecutionServiceDeps {
  runtime: Runtime;
  abortRegistry: JobAbortRegistryPort;
  backendNamespace: string;
  bundleHash: string;
  progressStore: JobProgressStore;
  providerRegistry: ProviderBindingCatalog;
  coordinatorCommit: CommitEventsFn;
  launchOrchestrator: WorkflowJobLifecyclePort;
  executionPort: WorkflowExecutionPort;
}

export class WorkflowExecutionService {
  private readonly deps: WorkflowExecutionServiceDeps;
  constructor(deps: WorkflowExecutionServiceDeps) {
    this.deps = deps;
  }

  async executeWorkflow(
    providerName: string,
    ast: PipelineAST,
    input: CanonicalWorkflowCommand,
    ctx: InvocationContext,
    workDir: CanonicalWorkDir,
  ): Promise<WorkflowLaunchDecision> {
    if (!this.deps.providerRegistry.get(providerName)) {
      return rejectLaunch('unknown_provider', `Unknown provider: ${providerName}`);
    }
    if (!hasProviderScope(ctx)) {
      return rejectLaunch(
        'provider_scope_missing',
        'This workflow request has no provider scope. Start it again from a launch-capable client with the selected provider profile.',
      );
    }
    const decodedScope = this.deps.providerRegistry.decodeCompleteScope(
      ctx.providerScope,
      workflowProviderNames(ast, providerName),
    );
    if (!decodedScope.ok) {
      return rejectLaunch(
        providerBindingFailureCode(decodedScope.failure),
        this.deps.providerRegistry.renderBindingFailure(decodedScope.failure),
      );
    }
    const boundCtx: InvocationContext = { ...ctx, providerScope: decodedScope.value };

    const jobId = this.deps.abortRegistry.register();
    let plan: ReturnType<typeof buildWorkflowPlan>;
    try {
      plan = buildWorkflowPlan(jobId, ast, { defaultProvider: providerName });
      this.deps.progressStore.commit((c) => {
        c.append(workflowPlanDeclaredEvent(jobId, plan, decodedScope.value));
        c.append({
          type: 'job.launch.requested',
          stream: { kind: 'job', id: jobId },
          namespace: this.deps.backendNamespace,
          project: ctx.projectRoot,
          refs: { jobId, workflowId: jobId },
          body: {
            owner: { kind: 'workflow', id: jobId },
            projectRoot: boundCtx.projectRoot,
            backendNamespace: this.deps.backendNamespace,
            bundleHash: this.deps.bundleHash,
            jobKind: 'workflow',
            pool: 'default',
            enqueueSequence: this.deps.progressStore.nextEnqueueSequence(),
            request: {
              prompt: input.startPrompt,
              cwd: workDir,
              bypassPermissions: false,
              coralEnv: { ...boundCtx.coralEnv },
            },
            createdAt: nowIsoString(this.deps.runtime.time),
          },
        });
        c.append({
          type: 'job.runtime.started',
          stream: { kind: 'job', id: jobId },
          namespace: this.deps.backendNamespace,
          project: ctx.projectRoot,
          refs: { jobId, workflowId: jobId },
          body: {
            transport: 'workflow',
            startedAt: nowIsoString(this.deps.runtime.time),
          },
        });
        return undefined;
      });
    } catch (error: unknown) {
      this.deps.abortRegistry.remove(jobId);
      throw error;
    }
    this.deps.launchOrchestrator.markJobRunning(jobId);

    this.runWorkflowAsync(jobId, providerName, ast, input, boundCtx, plan, workDir);
    return { kind: 'workflow', status: 'running', jobId, workflowId: jobId };
  }

  private commitWorkflowJobTerminal(jobId: string, intent: WorkflowFinalizationIntent): void {
    const status = this.deps.progressStore.readStatus(jobId);
    const namespace = status?.backendNamespace ?? this.deps.backendNamespace;
    const project = status?.projectRoot;
    const runtime = this.deps.progressStore.readRuntimeProjection(jobId);
    if (runtime?.transport !== 'workflow') {
      throw new Error(`Workflow '${jobId}' has no workflow runtime start.`);
    }
    const startedAt = Date.parse(runtime.startTime);
    if (!Number.isFinite(startedAt)) {
      throw new Error(`Workflow '${jobId}' has an invalid runtime start timestamp.`);
    }
    const durationMs = Math.max(0, this.deps.runtime.time.now() - startedAt);

    this.deps.coordinatorCommit((c) => {
      composeWorkflowFinalization(c, jobId, intent, { namespace, project, durationMs });
      return undefined;
    });
  }

  private finishWorkflowJobPostCommit(jobId: string, markdown: string): void {
    try {
      writeWorkflowResultArtifact(
        this.deps.runtime.storage,
        this.deps.runtime.paths.coral.exports.jobsRoot,
        jobId,
        markdown,
      );
    } catch (error: unknown) {
      backendLog.warn(`Writing terminal artifact failed for ${jobId}: ${errorMessage(error)}`);
    }
    this.deps.abortRegistry.remove(jobId);
  }

  private runWorkflowAsync(
    jobId: string,
    providerName: string,
    ast: PipelineAST,
    input: CanonicalWorkflowCommand,
    ctx: InvocationContext,
    declaredPlan: ReturnType<typeof buildWorkflowPlan>,
    workDir: CanonicalWorkDir,
  ): void {
    const signal = this.deps.abortRegistry.getSignal(jobId);
    if (!signal) return;

    void executePipeline(ast, input.startPrompt, providerName, this.deps.executionPort, ctx, {
      context: input.context,
      workDir,
      signal,
      onProgress: (message: string) => {
        this.deps.progressStore.appendProgress(jobId, null, message);
      },
      workflowJobId: jobId,
      declaredPlan,
      ids: this.deps.runtime.ids,
      journal: createWorkflowJournal({ commit: this.deps.coordinatorCommit }),
      time: this.deps.runtime.time,
      drainDeadlineMs: resolveDrainDeadlineMs(this.deps.runtime.env),
      staleAbortTimeoutMs: resolveStaleAbortTimeoutMs(this.deps.runtime.env),
    }).then(
      (result: PipelineResult) => {
        const serialized = serializeWorkflowResult(result.stepDetails);
        try {
          this.commitWorkflowJobTerminal(jobId, {
            outcome: 'completed',
            workflowJobId: jobId,
            finalOutput: result.finalOutput,
            stepDetails: result.stepDetails,
          });
          this.finishWorkflowJobPostCommit(jobId, serialized.markdown);
        } catch (error: unknown) {
          this.handleWorkflowFinalizationError(jobId, error);
        }
      },
      (err: unknown) => {
        try {
          this.handleWorkflowError(err, jobId);
        } catch (error: unknown) {
          this.handleWorkflowFinalizationError(jobId, error);
        }
      },
    );
  }

  private handleWorkflowError(err: unknown, jobId: string): void {
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

    const serialized = serializeWorkflowResult(stepDetails);
    this.commitWorkflowJobTerminal(jobId, intent);
    this.finishWorkflowJobPostCommit(jobId, serialized.markdown);
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
