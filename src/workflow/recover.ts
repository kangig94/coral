import type BetterSqlite3 from 'better-sqlite3';

import type { InvocationContext } from '../runtime/invocation-context.js';
import type { TimePort } from '../runtime/ports.js';
import { SYSTEM_TIME_PORT } from '../infra/time.js';
import type { JobTerminal } from '../jobs/records.js';
import type { CauseRef } from '../causality/cause-ref.js';
import type { TerminalOutcome } from '../jobs/outcome.js';
import type { ProgressStore } from '../jobs/job-store.js';
import type { JobProjectionDetail } from '../jobs/read-contract.js';
import { decodeBody, type StoreReadContext } from '../store/body-codec.js';
import { readLatestEvent } from '../store/event-queries.js';
import { loadJobProjectionDetails } from '../jobs/read-queries.js';
import { readProjectionJob, readWorkflowProjection } from './read-queries.js';
import {
  buildStepDetailsForAtoms,
  createWorkflowExecutionError,
  type LaunchedAtom,
  type PipelineResult,
  type StepDetail,
  type WorkflowExecutionPort,
} from './command.js';
import { describeTerminalFailure, formatStepOutput } from './command.js';
import {
  workflowCompletedBodySchema,
  workflowCompletedEvent,
  workflowDrainEnteredBodySchema,
} from './events.js';
import { executePlannedSteps } from './executor.js';
import { DEFAULT_STALE_TIMEOUT_MS, DEFAULT_STALE_CHECK_INTERVAL_MS } from './execution-constants.js';
import { compileWorkflowPlan, maxStepIndex, type CompiledPlanSlot, type WorkflowPlan } from './plan.js';
import { appendWorkflowEvents } from './projections.js';
import { recoverStaleAtom } from './stale-recovery.js';
import { waitForAtoms } from './wait.js';
export { recoverStaleAtom } from './stale-recovery.js';

type WorkflowSlotJobRow = {
  job_id: string;
  workflow_slot: string;
  last_seq: number;
};

function readSlotJobIds(db: BetterSqlite3.Database, workflowId: string, plan: WorkflowPlan): Map<string, string> {
  const slotIds = new Set(plan.slots.map((slot) => slot.slotId));
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

function compileSlotsForRecovery(db: BetterSqlite3.Database, workflowId: string, plan: WorkflowPlan): CompiledPlanSlot[] {
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
      coralOp: slot.kind === 'prompt' ? 'workflow-literal' : `coral:${slot.instruction}`,
      agent: slot.label,
      tagName: slot.tagName,
      stepIndex: slot.stepIndex,
      atomIndex,
      atomKey: slot.atomKey,
      kind: slot.kind,
    };
  });
}

function completedOutputForSlot(slot: CompiledPlanSlot, detailsByJob: Map<string, JobProjectionDetail>): string | null {
  return detailForJob(detailsByJob, slot.jobId).exit?.content ?? null;
}

function summarizeCompletedSteps(
  slots: readonly CompiledPlanSlot[],
  detailsByJob: Map<string, JobProjectionDetail>,
): {
  activeStepIndex: number;
  stepPrompt: string;
  stepDetails: StepDetail[];
} {
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
): {
  aborted: boolean;
  message: string;
  failedStep?: number;
  failedAtom?: string;
  failedJobId?: string;
  failedSlotId?: string;
  causeRef?: CauseRef;
  terminalOutcome?: TerminalOutcome;
  drainDeadline?: number;
} | null {
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

async function resumeWorkflow(
  db: BetterSqlite3.Database,
  progressStore: Pick<ProgressStore, 'listJobIds' | 'readStatus'> & StoreReadContext,
  executionSvc: WorkflowExecutionPort,
  ctx: InvocationContext,
  workflowId: string,
  plan: WorkflowPlan,
  options: {
    time: Pick<TimePort, 'now'>;
    onProgress: (workflowId: string, message: string) => void;
    staleTimeoutMs: number;
    staleCheckIntervalMs: number;
  },
): Promise<PipelineResult | null> {
  const readCtx: StoreReadContext = progressStore;
  const completionRow = readLatestEvent(db, 'workflow', workflowId, 'workflow.completed');
  const completion = completionRow ? decodeBody(completionRow, workflowCompletedBodySchema, readCtx) : null;
  if (completion) {
    return null;
  }

  const compiledSlots = compileSlotsForRecovery(db, workflowId, plan);
  const slotDetailsByJob = loadJobProjectionDetails(
    db,
    compiledSlots.map((slot) => slot.jobId),
    readCtx,
  );
  const summary = summarizeCompletedSteps(compiledSlots, slotDetailsByJob);
  const finalStepIndex = maxStepIndex(plan);
  if (summary.activeStepIndex > finalStepIndex) {
    appendWorkflowEvents(db, [workflowCompletedEvent(workflowId, { outcome: 'completed' })], options.time);
    return {
      finalOutput: summary.stepPrompt,
      stepDetails: summary.stepDetails,
    };
  }

  const stepSlots = compiledSlots.filter((slot) => slot.stepIndex === summary.activeStepIndex);
  const activeAtoms = buildLaunchedAtomsForStep(compiledSlots, summary.activeStepIndex, slotDetailsByJob);
  const missingProjection = stepSlots.some((slot) => {
    const projection = readProjectionJob(db, slot.jobId);
    const detail = detailForJob(slotDetailsByJob, slot.jobId);
    return projection === null && detail.status === null;
  });

  if (missingProjection) {
    options.onProgress(workflowId, `relaunching step ${summary.activeStepIndex}`);
    const resumed = await executePlannedSteps(plan, summary.stepPrompt, executionSvc, ctx, {
      startStepIndex: summary.activeStepIndex,
      completedStepDetails: summary.stepDetails,
      onProgress: (message) => options.onProgress(workflowId, message),
      staleTimeoutMs: options.staleTimeoutMs,
      staleCheckIntervalMs: options.staleCheckIntervalMs,
      workflowJobId: workflowId,
      time: options.time,
    });
    appendWorkflowEvents(db, [workflowCompletedEvent(workflowId, { outcome: 'completed' })], options.time);
    return {
      finalOutput: resumed.finalOutput,
      stepDetails: resumed.stepDetails,
    };
  }

  const completedOutputs = new Map<string, string>();
  const pendingCursorSeqs: number[] = [];
  const drainRow = readLatestEvent(db, 'workflow', workflowId, 'workflow.drain.entered');
  const drain = drainRow ? decodeBody(drainRow, workflowDrainEnteredBodySchema, readCtx) : null;

  for (const slot of stepSlots) {
    const detail = detailForJob(slotDetailsByJob, slot.jobId);
    if (detail.exit?.outcome.kind === 'completed') {
      completedOutputs.set(slot.atomKey, detail.exit.content);
      continue;
    }

    const projection = readProjectionJob(db, slot.jobId);
    if (projection) {
      pendingCursorSeqs.push(projection.lastSeq);
    }
  }

  const failure = firstTerminalFailure(compiledSlots, drain, slotDetailsByJob);
  const waitState = {
    completedOutputs,
    cursor: { afterSeq: pendingCursorSeqs.length === 0 ? 0 : Math.min(...pendingCursorSeqs) },
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

  const pendingPhases = stepSlots.flatMap((slot) => {
    const phase = detailForJob(slotDetailsByJob, slot.jobId).status?.phase;
    return phase === null || phase === undefined ? [] : [phase];
  });

  if (pendingPhases.some((phase) => phase !== 'running' && phase !== 'queued' && phase !== 'completed')) {
    if (failure) {
      appendWorkflowEvents(
        db,
        [
          workflowCompletedEvent(workflowId, {
            outcome: failure.aborted ? 'aborted' : 'failed',
            ...(failure.aborted || !failure.causeRef ? {} : { causeRef: failure.causeRef }),
          }),
        ],
        options.time,
      );
      throw createWorkflowExecutionError(failure.message, failure.aborted, summary.stepDetails, failure);
    }
  }

  options.onProgress(workflowId, `resuming step ${summary.activeStepIndex}`);
  const stepResults = await waitForAtoms(activeAtoms, executionSvc, ctx, {
    staleTimeoutMs: options.staleTimeoutMs,
    staleCheckIntervalMs: options.staleCheckIntervalMs,
    initialState: waitState,
    completedStepDetails: summary.stepDetails,
    workflowJobId: workflowId,
    onProgress: (message) => options.onProgress(workflowId, message),
    time: options.time,
    recoverStaleAtom,
  });

  const mergedResults = new Map(completedOutputs);
  for (const [key, value] of stepResults) {
    mergedResults.set(key, value);
  }

  const stepDetails = [...summary.stepDetails, ...buildStepDetailsForAtoms(activeAtoms, mergedResults)];
  const stepPrompt = formatStepOutput(
    activeAtoms.map((atom) => ({
      tagName: atom.tagName,
      output: mergedResults.get(atom.atomKey) ?? '',
    })),
  );

  const resumed = await executePlannedSteps(plan, stepPrompt, executionSvc, ctx, {
    startStepIndex: summary.activeStepIndex + 1,
    completedStepDetails: stepDetails,
    onProgress: (message) => options.onProgress(workflowId, message),
    staleTimeoutMs: options.staleTimeoutMs,
    staleCheckIntervalMs: options.staleCheckIntervalMs,
    workflowJobId: workflowId,
    time: options.time,
  });

  appendWorkflowEvents(db, [workflowCompletedEvent(workflowId, { outcome: 'completed' })], options.time);
  return {
    finalOutput: resumed.finalOutput,
    stepDetails: resumed.stepDetails,
  };
}

export async function resumeAll(options: {
  db: BetterSqlite3.Database;
  progressStore: Pick<ProgressStore, 'listJobIds' | 'readStatus'> & StoreReadContext;
  getExecutionService: (ctx: InvocationContext) => WorkflowExecutionPort;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  onProgress?: (workflowId: string, message: string) => void;
  staleTimeoutMs?: number;
  staleCheckIntervalMs?: number;
  time?: Pick<TimePort, 'now'>;
}): Promise<string[]> {
  const onProgress = options.onProgress ?? (() => {});
  const staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
  const staleCheckIntervalMs = options.staleCheckIntervalMs ?? DEFAULT_STALE_CHECK_INTERVAL_MS;
  const time = options.time ?? SYSTEM_TIME_PORT;
  const resumedWorkflowIds: string[] = [];

  for (const jobId of options.progressStore.listJobIds()) {
    const status = options.progressStore.readStatus(jobId);
    if (!status || status.jobKind !== 'workflow') continue;
    if (status.phase === 'completed' || status.phase === 'error' || status.phase === 'aborted') continue;

    const projection = readWorkflowProjection(options.db, jobId);
    if (!projection) continue;

    const ctx = options.createInvocationContext(status.projectRoot);
    await resumeWorkflow(options.db, options.progressStore, options.getExecutionService(ctx), ctx, jobId, projection.plan, {
      onProgress,
      staleTimeoutMs,
      staleCheckIntervalMs,
      time,
    });
    resumedWorkflowIds.push(jobId);
  }

  return resumedWorkflowIds;
}

export const workflowRecover = {
  resumeAll,
} as const;
