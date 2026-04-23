import type BetterSqlite3 from 'better-sqlite3';

import type { CallerContext } from '../infra/request-context.js';
import type { JobTerminal } from '../jobs/records.js';
import type { CauseRef, TerminalOutcome } from '../jobs/outcome.js';
import { errorMessage } from '../infra/error-format.js';
import type { ProgressStore } from '../jobs/job-store.js';
import type { JobProjectionDetail } from '../jobs/read-contracts.js';
import { decodeBody, type StoreReadContext } from '../store/body-codec.js';
import { readLatestEvent } from '../store/queries/events.js';
import { loadJobProjectionDetails } from '../store/queries/jobs.js';
import {
  buildStepDetailsForAtoms,
  createWorkflowExecutionError,
  type LaunchedAtom,
  type PipelineResult,
  type StepDetail,
  type WorkflowExecutionPort,
} from './command.js';
import { describeTerminalFailure, formatStepOutput } from './command.js';
import { BOOTSTRAP_TIMEOUT_MS, readLaunchFailureMessage } from './launch.js';
import {
  workflowCompletedBodySchema,
  workflowCompletedEvent,
  workflowDrainEnteredBodySchema,
  workflowPlanRevisedEvent,
} from './events.js';
import { executePlannedSteps, DEFAULT_STALE_TIMEOUT_MS, DEFAULT_WAIT_POLL_INTERVAL_MS } from './executor.js';
import { formatAtomProgress } from './internal/format.js';
import type { PlanSlot, WorkflowPlan } from './plan.js';
import { appendWorkflowEvents, readProjectionJob, readWorkflowProjection } from './projections.js';
import { waitForAtoms, type AwaitStepState } from './wait.js';

const MAX_STALE_RECOVERY_RETRIES = 2;
const STALE_ABORT_TIMEOUT_MS = 30_000;
const STALE_RESUME_PROMPT = 'Your previous execution timed out due to inactivity. Continue where you left off.';

function slotKind(slot: PlanSlot): 'agent' | 'prompt' {
  return slot.label === slot.instruction ? 'agent' : 'prompt';
}

function slotCoralOp(slot: PlanSlot): string {
  return slotKind(slot) === 'prompt' ? 'workflow-literal' : `coral:${slot.instruction}`;
}

function detailForJob(
  detailsByJob: Map<string, JobProjectionDetail>,
  jobId: string,
): JobProjectionDetail {
  return detailsByJob.get(jobId) ?? {
    status: null,
    launch: null,
    runtime: null,
    exit: null,
  };
}

function buildLaunchedAtomsForStep(
  plan: WorkflowPlan,
  stepIndex: number,
  detailsByJob: Map<string, JobProjectionDetail>,
): LaunchedAtom[] {
  const stepSlots = plan.slots.filter((slot) => slot.stepIndex === stepIndex);
  return stepSlots.map((slot, atomIndex) => {
    const detail = detailForJob(detailsByJob, slot.jobId);
    return {
      slotId: slot.slotId,
      jobId: slot.jobId,
      sessionId: detail.launch?.sessionId ?? slot.continuityRef ?? `unknown-session:${slot.slotId}`,
      providerName: slot.provider,
      coralOp: slotCoralOp(slot),
      agent: slot.label,
      tagName: slot.tagName,
      stepIndex: slot.stepIndex,
      atomIndex,
      atomKey: slot.atomKey,
      kind: slotKind(slot),
    };
  });
}

function completedOutputForSlot(slot: PlanSlot, detailsByJob: Map<string, JobProjectionDetail>): string | null {
  return detailForJob(detailsByJob, slot.jobId).exit?.content ?? null;
}

function summarizeCompletedSteps(
  plan: WorkflowPlan,
  detailsByJob: Map<string, JobProjectionDetail>,
): {
  activeStepIndex: number;
  stepPrompt: string;
  stepDetails: StepDetail[];
} {
  const stepDetails: StepDetail[] = [];
  let stepPrompt = '';
  const maxStepIndex = plan.slots.reduce((max, slot) => Math.max(max, slot.stepIndex), -1);

  for (let stepIndex = 0; stepIndex <= maxStepIndex; stepIndex += 1) {
    const stepSlots = plan.slots.filter((slot) => slot.stepIndex === stepIndex);
    if (stepSlots.length === 0) continue;

    const completed = stepSlots.map((slot) => completedOutputForSlot(slot, detailsByJob));
    if (completed.some((value) => value === null)) {
      return {
        activeStepIndex: stepIndex,
        stepPrompt,
        stepDetails,
      };
    }

    const launchedAtoms = buildLaunchedAtomsForStep(plan, stepIndex, detailsByJob);
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
    activeStepIndex: maxStepIndex + 1,
    stepPrompt,
    stepDetails,
  };
}

function firstTerminalFailure(
  plan: WorkflowPlan,
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
    (drain ? plan.slots.find((slot) => slot.slotId === drain.firstFailureSlotId) : undefined)
    ?? plan.slots.find((slot) => {
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
    ...(terminal.durationMs === undefined ? {} : { durationMs: terminal.durationMs }),
    ...(terminal.exitCode === undefined ? {} : { exitCode: terminal.exitCode }),
    ...(terminal.signal === undefined ? {} : { signal: terminal.signal }),
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

export async function recoverStaleAtom(
  state: AwaitStepState,
  executionSvc: WorkflowExecutionPort,
  ctx: CallerContext,
  options: {
    signal?: AbortSignal;
    staleTimeoutMs: number;
    workDir?: string;
    onProgress: (message: string) => void;
    buildPartialStepDetails: () => StepDetail[];
  },
): Promise<boolean> {
  const now = Date.now();

  for (const atom of state.pending.values()) {
    const lastActive = state.lastActivityAt.get(atom.atomKey) ?? now;
    if (now - lastActive < options.staleTimeoutMs) continue;

    const retries = state.staleRetries.get(atom.atomKey) ?? 0;
    if (retries >= MAX_STALE_RECOVERY_RETRIES) {
      throw createWorkflowExecutionError(
        `Step ${atom.stepIndex}, atom '${atom.agent}' stale after ${retries} recovery attempts`,
        false,
        options.buildPartialStepDetails(),
        {
          failedStep: atom.stepIndex,
          failedAtom: atom.agent,
          failedJobId: atom.jobId,
          failedSlotId: atom.slotId,
        },
      );
    }

    state.expectedStaleAborts.add(atom.jobId);
    options.onProgress(formatAtomProgress(atom, 'stale, aborting'));
    executionSvc.abort([atom.jobId]);

    try {
      await executionSvc.waitForJobTerminal(atom.jobId, STALE_ABORT_TIMEOUT_MS);
    } catch (error: unknown) {
      throw createWorkflowExecutionError(
        `Step ${atom.stepIndex}, atom '${atom.agent}' stale recovery abort failed: ${errorMessage(error)}`,
        false,
        options.buildPartialStepDetails(),
        {
          failedStep: atom.stepIndex,
          failedAtom: atom.agent,
          failedJobId: atom.jobId,
          failedSlotId: atom.slotId,
        },
      );
    }

    if (options.signal?.aborted) {
      throw createWorkflowExecutionError(
        'Pipeline aborted (launched atoms may continue)',
        true,
        options.buildPartialStepDetails(),
      );
    }

    const resumed = await executionSvc.resume(
      atom.providerName,
      {
        sessionId: atom.sessionId,
        prompt: STALE_RESUME_PROMPT,
        cwd: options.workDir ?? ctx.projectRoot,
      },
      ctx,
    );

    if (resumed.status === 'rejected' || !resumed.job || !resumed.session) {
      throw createWorkflowExecutionError(
        `Step ${atom.stepIndex}, atom '${atom.agent}' resume failed: ${resumed.message ?? 'unknown error'}`,
        false,
        options.buildPartialStepDetails(),
        {
          failedStep: atom.stepIndex,
          failedAtom: atom.agent,
          failedJobId: atom.jobId,
          failedSlotId: atom.slotId,
        },
      );
    }

    const launchState = await executionSvc.awaitLaunch(resumed.job, BOOTSTRAP_TIMEOUT_MS);
    if (launchState === 'error') {
      const message = await readLaunchFailureMessage(resumed.job, executionSvc, options.signal);
      throw createWorkflowExecutionError(
        `Step ${atom.stepIndex}, atom '${atom.agent}' resume failed: ${message ?? 'unknown error'}`,
        false,
        options.buildPartialStepDetails(),
        {
          failedStep: atom.stepIndex,
          failedAtom: atom.agent,
          failedJobId: atom.jobId,
          failedSlotId: atom.slotId,
        },
      );
    }

    state.pending.delete(atom.jobId);
    delete state.cursor.jobs[atom.jobId];
    state.pending.set(resumed.job, {
      ...atom,
      jobId: resumed.job,
      sessionId: resumed.session,
    });
    state.staleRetries.set(atom.atomKey, retries + 1);

    const resumedAt = Date.now();
    for (const sibling of state.pending.values()) {
      state.lastActivityAt.set(sibling.atomKey, resumedAt);
    }

    options.onProgress(formatAtomProgress(atom, 'resumed'));
    return true;
  }

  return false;
}

async function resumeWorkflow(
  db: BetterSqlite3.Database,
  progressStore: Pick<ProgressStore, 'listJobIds' | 'readStatus'> & StoreReadContext,
  executionSvc: WorkflowExecutionPort,
  ctx: CallerContext,
  plan: WorkflowPlan,
  options: {
    onProgress: (workflowId: string, message: string) => void;
    staleTimeoutMs: number;
    pollIntervalMs: number;
  },
): Promise<PipelineResult | null> {
  const readCtx: StoreReadContext = progressStore;
  const completionRow = readLatestEvent(db, 'workflow', plan.workflowId, 'workflow.completed');
  const completion = completionRow ? decodeBody(completionRow, workflowCompletedBodySchema, readCtx) : null;
  if (completion) {
    return null;
  }

  const slotDetailsByJob = loadJobProjectionDetails(db, plan.slots.map((slot) => slot.jobId), readCtx);
  const summary = summarizeCompletedSteps(plan, slotDetailsByJob);
  const maxStepIndex = plan.slots.reduce((max, slot) => Math.max(max, slot.stepIndex), -1);
  if (summary.activeStepIndex > maxStepIndex) {
    appendWorkflowEvents(db, [workflowCompletedEvent(plan.workflowId, { outcome: 'completed' })]);
    return {
      finalOutput: summary.stepPrompt,
      stepDetails: summary.stepDetails,
    };
  }

  const stepSlots = plan.slots.filter((slot) => slot.stepIndex === summary.activeStepIndex);
  const activeAtoms = buildLaunchedAtomsForStep(plan, summary.activeStepIndex, slotDetailsByJob);
  const missingProjection = stepSlots.some((slot) => {
    const projection = readProjectionJob(db, slot.jobId);
    const detail = detailForJob(slotDetailsByJob, slot.jobId);
    return projection === null && detail.status === null;
  });

  if (missingProjection) {
    options.onProgress(plan.workflowId, `relaunching step ${summary.activeStepIndex}`);
    const resumed = await executePlannedSteps(plan, summary.stepPrompt, executionSvc, ctx, {
      startStepIndex: summary.activeStepIndex,
      completedStepDetails: summary.stepDetails,
      onProgress: (message) => options.onProgress(plan.workflowId, message),
      staleTimeoutMs: options.staleTimeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      workflowJobId: plan.workflowId,
    });
    appendWorkflowEvents(db, [workflowCompletedEvent(plan.workflowId, { outcome: 'completed' })]);
    return {
      finalOutput: resumed.finalOutput,
      stepDetails: resumed.stepDetails,
    };
  }

  const completedOutputs = new Map<string, string>();
  const cursorJobs: Record<string, number> = {};
  const drainRow = readLatestEvent(db, 'workflow', plan.workflowId, 'workflow.drain.entered');
  const drain = drainRow ? decodeBody(drainRow, workflowDrainEnteredBodySchema, readCtx) : null;

  for (const slot of stepSlots) {
    const detail = detailForJob(slotDetailsByJob, slot.jobId);
    if (detail.exit?.outcome.kind === 'completed') {
      completedOutputs.set(slot.atomKey, detail.exit.content);
      continue;
    }

    const projection = readProjectionJob(db, slot.jobId);
    if (projection) {
      cursorJobs[slot.jobId] = projection.lastSeq;
    }
  }

  const failure = firstTerminalFailure(plan, drain, slotDetailsByJob);
  const waitState = {
    completedOutputs,
    cursor: { jobs: cursorJobs },
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
      appendWorkflowEvents(db, [
        workflowCompletedEvent(plan.workflowId, {
          outcome: failure.aborted ? 'aborted' : 'failed',
          ...(failure.aborted || !failure.causeRef ? {} : { causeRef: failure.causeRef }),
        }),
      ]);
      throw createWorkflowExecutionError(failure.message, failure.aborted, summary.stepDetails, failure);
    }
  }

  options.onProgress(plan.workflowId, `resuming step ${summary.activeStepIndex}`);
  const stepResults = await waitForAtoms(activeAtoms, executionSvc, ctx, {
    staleTimeoutMs: options.staleTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    initialState: waitState,
    completedStepDetails: summary.stepDetails,
    onProgress: (message) => options.onProgress(plan.workflowId, message),
    recoverStaleAtom,
    onStaleSwap: (state) => {
      const revisedPlan: WorkflowPlan = {
        workflowId: plan.workflowId,
        slots: plan.slots.map((slot) => {
          const revised = state.atoms.find((atom) => atom.slotId === slot.slotId);
          return revised ? { ...slot, jobId: revised.jobId, continuityRef: revised.sessionId } : slot;
        }),
      };
      appendWorkflowEvents(db, [workflowPlanRevisedEvent(plan.workflowId, revisedPlan)]);
      plan = revisedPlan;
    },
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
    onProgress: (message) => options.onProgress(plan.workflowId, message),
    staleTimeoutMs: options.staleTimeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    workflowJobId: plan.workflowId,
  });

  appendWorkflowEvents(db, [workflowCompletedEvent(plan.workflowId, { outcome: 'completed' })]);
  return {
    finalOutput: resumed.finalOutput,
    stepDetails: resumed.stepDetails,
  };
}

export async function resumeAll(options: {
  db: BetterSqlite3.Database;
  progressStore: Pick<ProgressStore, 'listJobIds' | 'readStatus'> & StoreReadContext;
  getExecutionService: (ctx: CallerContext) => WorkflowExecutionPort;
  createCallerContext: (projectRoot: string) => CallerContext;
  onProgress?: (workflowId: string, message: string) => void;
  staleTimeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<string[]> {
  const onProgress = options.onProgress ?? (() => {});
  const staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
  const resumedWorkflowIds: string[] = [];

  for (const jobId of options.progressStore.listJobIds()) {
    const status = options.progressStore.readStatus(jobId);
    if (!status || status.jobKind !== 'workflow') continue;
    if (status.phase === 'completed' || status.phase === 'error' || status.phase === 'aborted') continue;

    const projection = readWorkflowProjection(options.db, jobId);
    if (!projection) continue;

    const ctx = options.createCallerContext(status.projectRoot);
    await resumeWorkflow(options.db, options.progressStore, options.getExecutionService(ctx), ctx, projection.plan, {
      onProgress,
      staleTimeoutMs,
      pollIntervalMs,
    });
    resumedWorkflowIds.push(jobId);
  }

  return resumedWorkflowIds;
}
