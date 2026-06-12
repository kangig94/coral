import type { Database } from '../store/db.js';

import { errorMessage } from '../infra/error-format.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { TimePort } from '../infra/port-types.js';
import type { JobTerminal } from '../jobs/records.js';
import type { CauseRef } from '../causality/cause-ref.js';
import type { TerminalOutcome } from '../jobs/outcome.js';
import type { JobStore } from '../jobs/store.js';
import { decodeBody, type StoreReadContext } from '../store/body-codec.js';
import { readLatestEvent } from '../store/event-queries.js';
import type { JobProjectionDetail } from '../jobs/read-queries.js';
import { readProjectionJob, readWorkflowProjection } from './read-queries.js';
import {
  WorkflowExecutionError,
  buildStepDetailsForAtoms,
  createWorkflowExecutionError,
  type LaunchedAtom,
  type PipelineResult,
  type StepDetail,
  type WaitInternalState,
  type WorkflowExecutionPort,
} from './execution-contract.js';
import { describeTerminalFailure, formatStepOutput } from './command.js';
import { workflowCompletedBodySchema, workflowDrainEnteredBodySchema } from './events.js';
import { executePlannedSteps } from './executor.js';
import {
  DEFAULT_DRAIN_DEADLINE_MS,
  DEFAULT_STALE_CHECK_INTERVAL_MS,
  DEFAULT_STALE_TIMEOUT_MS,
} from './execution-constants.js';
import { compileWorkflowPlan, maxStepIndex, type CompiledPlanSlot, type WorkflowPlan } from './plan.js';
import { DEFAULT_STALE_ABORT_TIMEOUT_MS, recoverStaleAtom } from './stale-recovery.js';

import { waitForAtoms } from './wait.js';
import type { WorkflowFinalizationIntent } from './finalization.js';

type WorkflowSlotJobRow = {
  job_id: string;
  workflow_slot: string;
  last_seq: number;
};

type RecoveredWorkflowFinalization = {
  intent: WorkflowFinalizationIntent;
  error?: WorkflowExecutionError;
};

/**
 * Jobs-owned projection reader injected by the coordinator (architecture
 * ownership matrix: workflow reads jobs only via coordinator composition).
 * Production wiring binds `loadJobProjectionDetails` from jobs/read-queries.
 */
type LoadJobDetailsFn = (db: Database, jobIds: string[], ctx: StoreReadContext) => Map<string, JobProjectionDetail>;

type ResumeWorkflowDeps = {
  db: Database;
  progressStore: Pick<JobStore, 'readStatus'> & StoreReadContext;
  loadJobDetails: LoadJobDetailsFn;
  executionSvc: WorkflowExecutionPort;
  ctx: InvocationContext;
  workflowId: string;
  plan: WorkflowPlan;
  time: Pick<TimePort, 'now'>;
  onProgress: (workflowId: string, message: string) => void;
  staleTimeoutMs: number;
  staleCheckIntervalMs: number;
  staleAbortTimeoutMs: number;
  drainDeadlineMs: number;
};

type RecoverySummary = {
  activeStepIndex: number;
  stepPrompt: string;
  stepDetails: StepDetail[];
};

type RecoveryTerminalFailure = {
  aborted: boolean;
  message: string;
  failedStep?: number;
  failedAtom?: string;
  failedJobId?: string;
  failedSlotId?: string;
  causeRef?: CauseRef;
  terminalOutcome?: TerminalOutcome;
  drainDeadline?: number;
};

type RecoverySnapshot = {
  readCtx: StoreReadContext;
  compiledSlots: CompiledPlanSlot[];
  slotDetailsByJob: Map<string, JobProjectionDetail>;
  summary: RecoverySummary;
  stepSlots: CompiledPlanSlot[];
  activeAtoms: LaunchedAtom[];
};

type WaitRecoveryPlan = {
  activeAtoms: LaunchedAtom[];
  completedOutputs: Map<string, string>;
  initialState: Partial<WaitInternalState>;
  blockingFailure: RecoveryTerminalFailure | null;
};

function readSlotJobIds(db: Database, workflowId: string, plan: WorkflowPlan): Map<string, string> {
  const slotIds = new Set<string>();
  for (const slot of plan.slots) {
    slotIds.add(slot.slotId);
  }
  const rows = db
    .prepare(
      `SELECT job_id, workflow_slot, last_seq
         FROM projection_jobs
        WHERE parent_workflow_job_id = ?
          AND workflow_slot IS NOT NULL
        ORDER BY workflow_slot ASC, last_seq DESC`,
    )
    .all(workflowId) as WorkflowSlotJobRow[];
  const selected = new Map<string, string>();

  for (const row of rows) {
    if (!slotIds.has(row.workflow_slot) || selected.has(row.workflow_slot)) {
      continue;
    }
    selected.set(row.workflow_slot, row.job_id);
  }

  return selected;
}

function compileSlotsForRecovery(db: Database, workflowId: string, plan: WorkflowPlan): CompiledPlanSlot[] {
  return compileWorkflowPlan(plan, { jobIds: readSlotJobIds(db, workflowId, plan) });
}

function detailForJob(detailsByJob: Map<string, JobProjectionDetail>, jobId: string): JobProjectionDetail {
  return (
    detailsByJob.get(jobId) ?? {
      status: null,
      launch: null,
      runtime: null,
      exit: null,
    }
  );
}

function buildLaunchedAtomsForStep(
  slots: readonly CompiledPlanSlot[],
  stepIndex: number,
  detailsByJob: Map<string, JobProjectionDetail>,
): LaunchedAtom[] {
  const stepSlots = slots.filter((slot) => slot.stepIndex === stepIndex);
  return stepSlots.map((slot, atomIndex) => {
    const detail = detailForJob(detailsByJob, slot.jobId);
    return {
      slotId: slot.slotId,
      jobId: slot.jobId,
      sessionId: detail.launch?.sessionId ?? `unknown-session:${slot.slotId}`,
      providerName: slot.provider,
      agent: slot.label,
      tagName: slot.tagName,
      stepIndex: slot.stepIndex,
      atomIndex,
      atomKey: slot.atomKey,
    };
  });
}

function completedOutputForSlot(slot: CompiledPlanSlot, detailsByJob: Map<string, JobProjectionDetail>): string | null {
  return detailForJob(detailsByJob, slot.jobId).exit?.content ?? null;
}

function summarizeCompletedSteps(
  slots: readonly CompiledPlanSlot[],
  detailsByJob: Map<string, JobProjectionDetail>,
): RecoverySummary {
  const stepDetails: StepDetail[] = [];
  let stepPrompt = '';
  const finalStepIndex = slots.reduce((max, slot) => Math.max(max, slot.stepIndex), -1);

  for (let stepIndex = 0; stepIndex <= finalStepIndex; stepIndex += 1) {
    const stepSlots = slots.filter((slot) => slot.stepIndex === stepIndex);
    if (stepSlots.length === 0) continue;

    const completed = stepSlots.map((slot) => completedOutputForSlot(slot, detailsByJob));
    if (completed.some((value) => value === null)) {
      return {
        activeStepIndex: stepIndex,
        stepPrompt,
        stepDetails,
      };
    }

    const launchedAtoms = buildLaunchedAtomsForStep(slots, stepIndex, detailsByJob);
    const results = new Map<string, string>();
    launchedAtoms.forEach((atom, index) => {
      results.set(atom.atomKey, completed[index] ?? '');
    });
    stepDetails.push(...buildStepDetailsForAtoms(launchedAtoms, results));
    stepPrompt = formatStepOutput(
      launchedAtoms.map((atom) => ({
        tagName: atom.tagName,
        output: results.get(atom.atomKey) ?? '',
      })),
    );
  }

  return {
    activeStepIndex: finalStepIndex + 1,
    stepPrompt,
    stepDetails,
  };
}

function firstTerminalFailure(
  slots: readonly CompiledPlanSlot[],
  drain: { firstFailureSlotId: string; drainDeadline: number } | null,
  detailsByJob: Map<string, JobProjectionDetail>,
): RecoveryTerminalFailure | null {
  const targetSlot =
    (drain ? slots.find((slot) => slot.slotId === drain.firstFailureSlotId) : undefined) ??
    slots.find((slot) => {
      const detail = detailForJob(detailsByJob, slot.jobId);
      const outcome = detail.exit?.outcome;
      return outcome && outcome.kind !== 'completed';
    });

  if (!targetSlot) {
    return null;
  }

  const detail = detailForJob(detailsByJob, targetSlot.jobId);
  const terminal = detail.exit;
  if (!terminal) {
    return null;
  }

  const result: JobTerminal = {
    content: terminal.content,
    outcome: terminal.outcome,
    durationMs: terminal.durationMs,
  };

  return {
    aborted: terminal.outcome.kind === 'aborted',
    message: `Step ${targetSlot.stepIndex}, atom '${targetSlot.label}' failed: ${describeTerminalFailure(result)}`,
    failedStep: targetSlot.stepIndex,
    failedAtom: targetSlot.label,
    failedJobId: targetSlot.jobId,
    failedSlotId: targetSlot.slotId,
    causeRef: terminal.outcome.kind === 'failed' ? terminal.outcome.causeRef : undefined,
    terminalOutcome: terminal.outcome,
    drainDeadline: drain?.drainDeadline,
  };
}

function completedRecoveryIntent(workflowId: string, result: PipelineResult): WorkflowFinalizationIntent {
  return {
    outcome: 'completed',
    workflowJobId: workflowId,
    finalOutput: result.finalOutput,
    stepDetails: result.stepDetails,
  };
}

function stackFor(error: unknown): string | undefined {
  return error instanceof Error && typeof error.stack === 'string' && error.stack.length > 0 ? error.stack : undefined;
}

function recoveryIntentFromFailure(
  workflowId: string,
  failure: {
    aborted: boolean;
    message: string;
    causeRef?: CauseRef;
    terminalOutcome?: TerminalOutcome;
    failedSlotId?: string;
    failedStep?: number;
    failedAtom?: string;
    failedJobId?: string;
  },
  stepDetails: StepDetail[],
): WorkflowFinalizationIntent {
  if (failure.aborted && failure.causeRef === undefined) {
    return {
      outcome: 'aborted',
      workflowJobId: workflowId,
      reason: failure.terminalOutcome?.kind === 'aborted' ? failure.terminalOutcome.reason : 'signal_abort',
      stepDetails,
    };
  }

  const failureLocation = (() => {
    const location = {
      ...(failure.failedSlotId === undefined ? {} : { slotId: failure.failedSlotId }),
      ...(failure.failedStep === undefined ? {} : { stepIndex: failure.failedStep }),
      ...(failure.failedAtom === undefined ? {} : { atomLabel: failure.failedAtom }),
      ...(failure.failedJobId === undefined ? {} : { jobId: failure.failedJobId }),
    };
    return Object.keys(location).length === 0 ? undefined : location;
  })();

  return {
    outcome: 'failed',
    workflowJobId: workflowId,
    ...(failure.causeRef === undefined ? {} : { causeRef: failure.causeRef }),
    lifecycleFault: {
      kind: 'recovery_failed',
      message: failure.message,
    },
    stepDetails,
    ...(failureLocation === undefined ? {} : { failureLocation }),
  };
}

function recoveryIntentFromError(workflowId: string, error: unknown): WorkflowFinalizationIntent {
  if (error instanceof WorkflowExecutionError) {
    return recoveryIntentFromFailure(workflowId, error, error.stepDetails);
  }

  const stack = stackFor(error);
  return {
    outcome: 'failed',
    workflowJobId: workflowId,
    lifecycleFault: {
      kind: 'recovery_failed',
      message: errorMessage(error),
      ...(stack === undefined ? {} : { stack }),
    },
    stepDetails: [],
  };
}

function detectExistingCompletion(deps: ResumeWorkflowDeps): boolean {
  const completionRow = readLatestEvent(deps.db, 'workflow', deps.workflowId, 'workflow.completed');
  const completion = completionRow ? decodeBody(completionRow, workflowCompletedBodySchema, deps.progressStore) : null;
  return completion !== null;
}

function loadRecoverySnapshot(deps: ResumeWorkflowDeps): RecoverySnapshot {
  const readCtx: StoreReadContext = deps.progressStore;
  const compiledSlots = compileSlotsForRecovery(deps.db, deps.workflowId, deps.plan);
  const slotDetailsByJob = deps.loadJobDetails(
    deps.db,
    compiledSlots.map((slot) => slot.jobId),
    readCtx,
  );
  const summary = summarizeCompletedSteps(compiledSlots, slotDetailsByJob);
  const stepSlots = compiledSlots.filter((slot) => slot.stepIndex === summary.activeStepIndex);
  const activeAtoms = buildLaunchedAtomsForStep(compiledSlots, summary.activeStepIndex, slotDetailsByJob);
  return { readCtx, compiledSlots, slotDetailsByJob, summary, stepSlots, activeAtoms };
}

function completedFinalization(deps: ResumeWorkflowDeps, summary: RecoverySummary): RecoveredWorkflowFinalization {
  return {
    intent: completedRecoveryIntent(deps.workflowId, {
      finalOutput: summary.stepPrompt,
      stepDetails: summary.stepDetails,
    }),
  };
}

function shouldRelaunchActiveStep(deps: ResumeWorkflowDeps, snapshot: RecoverySnapshot): boolean {
  return snapshot.stepSlots.some((slot) => {
    const projection = readProjectionJob(deps.db, slot.jobId);
    const detail = detailForJob(snapshot.slotDetailsByJob, slot.jobId);
    return projection === null && detail.status === null;
  });
}

async function executeRemainingSteps(
  deps: ResumeWorkflowDeps,
  initialPrompt: string,
  startStepIndex: number,
  completedStepDetails: StepDetail[],
): Promise<PipelineResult> {
  return executePlannedSteps(deps.plan, initialPrompt, deps.executionSvc, deps.ctx, {
    startStepIndex,
    completedStepDetails,
    onProgress: (message) => deps.onProgress(deps.workflowId, message),
    staleTimeoutMs: deps.staleTimeoutMs,
    staleCheckIntervalMs: deps.staleCheckIntervalMs,
    staleAbortTimeoutMs: deps.staleAbortTimeoutMs,
    drainDeadlineMs: deps.drainDeadlineMs,
    workflowJobId: deps.workflowId,
    time: deps.time,
  });
}

async function assembleRelaunch(
  deps: ResumeWorkflowDeps,
  summary: RecoverySummary,
): Promise<RecoveredWorkflowFinalization> {
  deps.onProgress(deps.workflowId, `relaunching step ${summary.activeStepIndex}`);
  const resumed = await executeRemainingSteps(deps, summary.stepPrompt, summary.activeStepIndex, summary.stepDetails);
  return { intent: completedRecoveryIntent(deps.workflowId, resumed) };
}

function buildWaitRecoveryPlan(deps: ResumeWorkflowDeps, snapshot: RecoverySnapshot): WaitRecoveryPlan {
  const completedOutputs = new Map<string, string>();
  let pendingCursorSeq: number | null = null;
  const drainRow = readLatestEvent(deps.db, 'workflow', deps.workflowId, 'workflow.drain.entered');
  const drain = drainRow ? decodeBody(drainRow, workflowDrainEnteredBodySchema, snapshot.readCtx) : null;

  for (const slot of snapshot.stepSlots) {
    const detail = detailForJob(snapshot.slotDetailsByJob, slot.jobId);
    if (detail.exit?.outcome.kind === 'completed') {
      completedOutputs.set(slot.atomKey, detail.exit.content);
      continue;
    }

    const projection = readProjectionJob(deps.db, slot.jobId);
    if (projection) {
      pendingCursorSeq =
        pendingCursorSeq === null ? projection.lastSeq : Math.min(pendingCursorSeq, projection.lastSeq);
    }
  }

  const failure = firstTerminalFailure(snapshot.compiledSlots, drain, snapshot.slotDetailsByJob);
  const initialState: Partial<WaitInternalState> = {
    completedOutputs,
    cursor: { afterSeq: pendingCursorSeq ?? 0 },
    lastActivityAt: new Map<string, number>(),
    staleRetries: new Map<string, number>(),
    expectedStaleAborts: new Set<string>(),
    ...(failure?.drainDeadline === undefined
      ? {}
      : {
          failureDrain: {
            firstFailure: failure,
            abortRequested: true,
            drainDeadline: failure.drainDeadline,
          },
        }),
  };
  const pendingPhases: string[] = [];
  for (const slot of snapshot.stepSlots) {
    const phase = detailForJob(snapshot.slotDetailsByJob, slot.jobId).status?.phase;
    if (phase !== null && phase !== undefined) {
      pendingPhases.push(phase);
    }
  }
  const blockingFailure = pendingPhases.some(
    (phase) => phase !== 'running' && phase !== 'queued' && phase !== 'completed',
  )
    ? failure
    : null;

  return { activeAtoms: snapshot.activeAtoms, completedOutputs, initialState, blockingFailure };
}

function blockingFailureFinalization(
  workflowId: string,
  summary: RecoverySummary,
  failure: RecoveryTerminalFailure | null,
): RecoveredWorkflowFinalization | null {
  if (failure === null) return null;
  const workflowError = createWorkflowExecutionError(failure.message, failure.aborted, summary.stepDetails, failure);
  return {
    intent: recoveryIntentFromFailure(workflowId, failure, summary.stepDetails),
    error: workflowError,
  };
}

async function continueAfterRecoveredStep(
  deps: ResumeWorkflowDeps,
  summary: RecoverySummary,
  plan: WaitRecoveryPlan,
  stepResults: Map<string, string>,
): Promise<RecoveredWorkflowFinalization> {
  const mergedResults = new Map(plan.completedOutputs);
  for (const [key, value] of stepResults) {
    mergedResults.set(key, value);
  }

  const stepDetails = [...summary.stepDetails, ...buildStepDetailsForAtoms(plan.activeAtoms, mergedResults)];
  const stepPrompt = formatStepOutput(
    plan.activeAtoms.map((atom) => ({
      tagName: atom.tagName,
      output: mergedResults.get(atom.atomKey) ?? '',
    })),
  );
  const resumed = await executeRemainingSteps(deps, stepPrompt, summary.activeStepIndex + 1, stepDetails);
  return { intent: completedRecoveryIntent(deps.workflowId, resumed) };
}

async function waitAndFinalize(
  deps: ResumeWorkflowDeps,
  snapshot: RecoverySnapshot,
): Promise<RecoveredWorkflowFinalization> {
  const plan = buildWaitRecoveryPlan(deps, snapshot);
  const blocked = blockingFailureFinalization(deps.workflowId, snapshot.summary, plan.blockingFailure);
  if (blocked !== null) return blocked;

  deps.onProgress(deps.workflowId, `resuming step ${snapshot.summary.activeStepIndex}`);
  const stepResults = await waitForAtoms(plan.activeAtoms, deps.executionSvc, deps.ctx, {
    staleTimeoutMs: deps.staleTimeoutMs,
    staleCheckIntervalMs: deps.staleCheckIntervalMs,
    staleAbortTimeoutMs: deps.staleAbortTimeoutMs,
    drainDeadlineMs: deps.drainDeadlineMs,
    initialState: plan.initialState,
    completedStepDetails: snapshot.summary.stepDetails,
    workflowJobId: deps.workflowId,
    onProgress: (message) => deps.onProgress(deps.workflowId, message),
    time: deps.time,
    recoverStaleAtom,
  });
  return continueAfterRecoveredStep(deps, snapshot.summary, plan, stepResults);
}

async function resumeWorkflow(deps: ResumeWorkflowDeps): Promise<RecoveredWorkflowFinalization | null> {
  if (detectExistingCompletion(deps)) {
    return null;
  }

  const snapshot = loadRecoverySnapshot(deps);
  if (snapshot.summary.activeStepIndex > maxStepIndex(deps.plan)) {
    return completedFinalization(deps, snapshot.summary);
  }

  if (shouldRelaunchActiveStep(deps, snapshot)) {
    return assembleRelaunch(deps, snapshot.summary);
  }

  return waitAndFinalize(deps, snapshot);
}

export async function resumeAll(options: {
  db: Database;
  progressStore: Pick<JobStore, 'listJobIds' | 'readStatus'> & StoreReadContext;
  loadJobDetails: LoadJobDetailsFn;
  getExecutionService: (ctx: InvocationContext) => WorkflowExecutionPort;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  finalizeWorkflow: (intent: WorkflowFinalizationIntent) => void;
  onProgress?: (workflowId: string, message: string) => void;
  staleTimeoutMs?: number;
  staleCheckIntervalMs?: number;
  staleAbortTimeoutMs?: number;
  drainDeadlineMs?: number;
  time: Pick<TimePort, 'now'>;
}): Promise<string[]> {
  const onProgress = options.onProgress ?? (() => {});
  const staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
  const staleCheckIntervalMs = options.staleCheckIntervalMs ?? DEFAULT_STALE_CHECK_INTERVAL_MS;
  const staleAbortTimeoutMs = options.staleAbortTimeoutMs ?? DEFAULT_STALE_ABORT_TIMEOUT_MS;
  const drainDeadlineMs = options.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS;
  const time = options.time;
  const resumedWorkflowIds: string[] = [];

  for (const jobId of options.progressStore.listJobIds()) {
    const status = options.progressStore.readStatus(jobId);
    if (!status || status.jobKind !== 'workflow') continue;
    if (status.phase === 'completed' || status.phase === 'error' || status.phase === 'aborted') continue;

    const projection = readWorkflowProjection(options.db, jobId);
    if (!projection) {
      options.finalizeWorkflow({
        outcome: 'failed',
        workflowJobId: jobId,
        lifecycleFault: {
          kind: 'recovery_failed',
          message: 'Workflow recovery could not find a workflow projection.',
        },
        stepDetails: [],
      });
      resumedWorkflowIds.push(jobId);
      continue;
    }

    const ctx = options.createInvocationContext(status.projectRoot);
    let recovered: RecoveredWorkflowFinalization | null;
    try {
      recovered = await resumeWorkflow({
        db: options.db,
        progressStore: options.progressStore,
        loadJobDetails: options.loadJobDetails,
        executionSvc: options.getExecutionService(ctx),
        ctx,
        workflowId: jobId,
        plan: projection.plan,
        onProgress,
        staleTimeoutMs,
        staleCheckIntervalMs,
        staleAbortTimeoutMs,
        drainDeadlineMs,
        time,
      });
    } catch (error: unknown) {
      options.finalizeWorkflow(recoveryIntentFromError(jobId, error));
      throw error;
    }

    if (recovered === null) {
      continue;
    }

    options.finalizeWorkflow(recovered.intent);
    if (recovered.error) {
      throw recovered.error;
    }
    resumedWorkflowIds.push(jobId);
  }

  return resumedWorkflowIds;
}

export const workflowRecover = {
  resumeAll,
} as const;
