import type { Database } from '../store/db.js';

import { errorMessage } from '../infra/error-format.js';
import { isAbortError } from '../runtime/abort.js';
import { describeSessionJobClaimReleaseResult } from '../sessions/job-release.js';
import type { SessionJobClaimReleaseResult } from '../sessions/contracts.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import type { TimePort } from '../infra/port-types.js';
import { nowIsoString } from '../infra/time.js';
import type { JobTerminal } from '../jobs/records.js';
import type { CauseRef } from '../causality/cause-ref.js';
import { phaseForOutcome, type TerminalOutcome } from '../jobs/outcome.js';
import type { JobStore } from '../jobs/store.js';
import { decodeBody, type StoreReadContext } from '../store/body-codec.js';
import { getEvent, readLatestEvent } from '../store/event-queries.js';
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
import { BOOTSTRAP_TIMEOUT_MS, handleStepLaunchFailure, launchCompiledStepAtoms } from './launch.js';
import {
  DEFAULT_DRAIN_DEADLINE_MS,
  DEFAULT_STALE_CHECK_INTERVAL_MS,
  DEFAULT_STALE_TIMEOUT_MS,
} from './execution-constants.js';
import { compileWorkflowPlan, maxStepIndex, type CompiledPlanSlot, type WorkflowPlan } from './plan.js';
import { DEFAULT_STALE_ABORT_TIMEOUT_MS, recoverStaleAtom, STALE_RESUME_PROMPT } from './stale-recovery.js';

import { waitForAtoms } from './wait.js';
import type { WorkflowFinalizationIntent } from './finalization.js';
import { providerSessionProvider } from '../sessions/entry.js';
import { readProviderSessionById } from '../sessions/read-queries.js';
import { readProjectionJobRows, type ProjectionJobStoredRow } from '../jobs/projection-row.js';

type WorkflowSlotJobRow = ProjectionJobStoredRow & { workflow_slot: string };

type RecoveredWorkflowFinalization = {
  intent: WorkflowFinalizationIntent;
  error?: WorkflowExecutionError;
};

export type WorkflowRecoveryDescendantRelease = {
  jobId: string;
  sessionId: string;
  sessionClaimRelease: SessionJobClaimReleaseResult;
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

type ActiveStepLaunchState =
  | { kind: 'all-launched'; neverLaunchedSlots: [] }
  | { kind: 'all-never-launched'; neverLaunchedSlots: CompiledPlanSlot[] }
  | { kind: 'mixed'; neverLaunchedSlots: CompiledPlanSlot[] };

function readSlotJobIds(db: Database, workflowId: string, plan: WorkflowPlan): Map<string, string> {
  const slotIds = new Set<string>();
  for (const slot of plan.slots) {
    slotIds.add(slot.slotId);
  }
  const rows = readProjectionJobRows(db)
    .filter((row): row is WorkflowSlotJobRow => row.parent_workflow_job_id === workflowId && row.workflow_slot !== null)
    .sort(
      (left, right) =>
        left.workflow_slot.localeCompare(right.workflow_slot) ||
        (left.workflow_slot_generation ?? 0) - (right.workflow_slot_generation ?? 0),
    );
  const selected = new Map<string, string>();
  const expectedGeneration = new Map<string, number>();
  const previousJob = new Map<string, string>();
  const nonterminalBySlot = new Set<string>();

  for (const row of rows) {
    if (!slotIds.has(row.workflow_slot)) continue;
    const expected = expectedGeneration.get(row.workflow_slot) ?? 0;
    const predecessor = previousJob.get(row.workflow_slot);
    if (
      row.workflow_slot_generation !== expected ||
      (expected === 0 ? row.replaces_workflow_job_id !== null : row.replaces_workflow_job_id !== predecessor)
    ) {
      throw new Error(
        `Workflow recovery rejected invalid child chain for slot '${row.workflow_slot}' at job '${row.job_id}'.`,
      );
    }
    if (row.terminal === null) {
      if (nonterminalBySlot.has(row.workflow_slot)) {
        throw new Error(`Workflow recovery rejected duplicate nonterminal children for slot '${row.workflow_slot}'.`);
      }
      nonterminalBySlot.add(row.workflow_slot);
    } else if (nonterminalBySlot.has(row.workflow_slot)) {
      throw new Error(
        `Workflow recovery rejected a terminal child after the current child for slot '${row.workflow_slot}'.`,
      );
    }
    selected.set(row.workflow_slot, row.job_id);
    previousJob.set(row.workflow_slot, row.job_id);
    expectedGeneration.set(row.workflow_slot, expected + 1);
  }

  return selected;
}

async function resumePendingReplacementIntents(deps: ResumeWorkflowDeps): Promise<void> {
  const slotJobs = readSlotJobIds(deps.db, deps.workflowId, deps.plan);
  const details = deps.loadJobDetails(deps.db, [...slotJobs.values()], deps.progressStore);
  for (const slot of deps.plan.slots) {
    const jobId = slotJobs.get(slot.slotId);
    if (jobId === undefined) continue;
    const detail = details.get(jobId);
    const launch = detail?.launch;
    if (
      launch === null ||
      launch === undefined ||
      launch.sessionId === null ||
      launch.workflowSlotGeneration === undefined ||
      detail?.exit === null ||
      detail?.exit === undefined ||
      !isRecoverableReplacementCrash(deps, detail.exit.outcome)
    ) {
      continue;
    }
    const session = readProviderSessionById(deps.db, launch.sessionId);
    const intent = session.continuationLease;
    const nextGeneration = launch.workflowSlotGeneration + 1;
    const pendingForCurrent =
      intent?.status === 'pending' &&
      intent.staleJobId === jobId &&
      intent.workflowId === deps.workflowId &&
      intent.workflowSlotId === slot.slotId &&
      intent.replacementGeneration === nextGeneration;
    const priorReplacementForCurrent =
      (intent?.status === 'claimed' || intent?.status === 'cleared') &&
      intent.resumedJobId === jobId &&
      intent.workflowId === deps.workflowId &&
      intent.workflowSlotId === slot.slotId &&
      intent.replacementGeneration === launch.workflowSlotGeneration;
    if (!pendingForCurrent && !priorReplacementForCurrent) {
      continue;
    }

    // A daemon can die either after recording the pending intent or immediately
    // after the atomic claim+launch transaction. Re-recording an expired intent,
    // or advancing a released claimed intent, gives the new atomic replacement
    // transaction a live lease without guessing from ambient daemon state.
    if (
      priorReplacementForCurrent ||
      (pendingForCurrent && intent.status === 'pending' && Date.parse(intent.expiresAt) <= deps.time.now())
    ) {
      await deps.executionSvc.recordContinuationLease({
        sessionId: launch.sessionId,
        jobId,
        workflowId: deps.workflowId,
        workflowSlotId: slot.slotId,
        replacementGeneration: nextGeneration,
        reason: 'stale_recovery',
        expiresAt: replacementRecoveryLeaseExpiresAt(deps),
      });
    }
    deps.onProgress(deps.workflowId, `completing replacement intent for slot ${slot.slotId}`);
    const resumed = await deps.executionSvc.resume(
      slot.provider,
      {
        sessionId: launch.sessionId,
        prompt: STALE_RESUME_PROMPT,
        cwd: launch.request.cwd ?? deps.ctx.projectRoot,
        parentWorkflowJobId: deps.workflowId,
        workflowSlotId: slot.slotId,
        workflowSlotGeneration: nextGeneration,
        replacesWorkflowJobId: jobId,
        owner: { kind: 'workflow', id: deps.workflowId },
      },
      deps.ctx,
    );
    if (resumed.status === 'rejected') {
      throw new Error(
        `Workflow recovery could not complete replacement intent for slot '${slot.slotId}': ${resumed.message ?? 'unknown error'}.`,
      );
    }
    const readiness = await deps.executionSvc.awaitLaunch(resumed.jobId, BOOTSTRAP_TIMEOUT_MS);
    if (readiness === 'error') {
      throw new Error(`Workflow recovery replacement '${resumed.jobId}' failed to launch for slot '${slot.slotId}'.`);
    }
  }
}

function replacementRecoveryLeaseExpiresAt(deps: ResumeWorkflowDeps): string {
  const minimumTtlMs = 60_000;
  return nowIsoString(deps.time.now() + Math.max(minimumTtlMs, deps.staleAbortTimeoutMs + BOOTSTRAP_TIMEOUT_MS));
}

function isRecoverableReplacementCrash(deps: ResumeWorkflowDeps, outcome: TerminalOutcome): boolean {
  if (outcome.kind === 'aborted') return true;
  if (outcome.kind === 'job_fault') {
    return outcome.fault.kind === 'ghost_launch' || outcome.fault.kind === 'wrapper_lost';
  }
  if (outcome.kind !== 'failed') return false;

  const cause = getEvent(deps.db, outcome.causeRef.stream, outcome.causeRef.seq, deps.progressStore);
  return cause?.type === 'session.interrupted';
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
  return stepSlots.flatMap((slot, atomIndex) => {
    const detail = detailForJob(detailsByJob, slot.jobId);
    if (detail.launch === null || detail.launch.sessionId === null) {
      return [];
    }
    if (detail.launch.workflowSlotGeneration === undefined) {
      throw new Error(`Workflow child '${slot.jobId}' has no slot generation.`);
    }
    return [
      {
        slotId: slot.slotId,
        jobId: slot.jobId,
        sessionId: detail.launch.sessionId,
        providerName: slot.provider,
        agent: slot.label,
        tagName: slot.tagName,
        stepIndex: slot.stepIndex,
        atomIndex,
        atomKey: slot.atomKey,
        generation: detail.launch.workflowSlotGeneration,
      },
    ];
  });
}

function validateDurableSlotRelations(
  deps: ResumeWorkflowDeps,
  slots: readonly CompiledPlanSlot[],
  detailsByJob: ReadonlyMap<string, JobProjectionDetail>,
): void {
  for (const slot of slots) {
    if (readProjectionJob(deps.db, slot.jobId) === null) continue;

    const launch = detailsByJob.get(slot.jobId)?.launch ?? null;
    const validWorkflowRelation =
      launch?.jobKind === 'provider' &&
      launch.owner.kind === 'workflow' &&
      launch.owner.id === deps.workflowId &&
      launch.parentWorkflowJobId === deps.workflowId &&
      launch.workflowSlotId === slot.slotId &&
      launch.provider === slot.provider &&
      launch.sessionId !== null;
    if (!validWorkflowRelation || launch === null || launch.sessionId === null || launch.provider === null) {
      throw new Error(
        `Workflow recovery rejected invalid durable relation for slot '${slot.slotId}' and job '${slot.jobId}'.`,
      );
    }

    let session;
    try {
      session = readProviderSessionById(deps.db, launch.sessionId);
    } catch {
      throw new Error(
        `Workflow recovery could not find provider session '${launch.sessionId}' for slot '${slot.slotId}'.`,
      );
    }
    if (providerSessionProvider(session) !== slot.provider) {
      throw new Error(
        `Workflow recovery rejected provider session '${launch.sessionId}' for slot '${slot.slotId}': expected '${slot.provider}'.`,
      );
    }
  }
}

function completedOutputForSlot(slot: CompiledPlanSlot, detailsByJob: Map<string, JobProjectionDetail>): string | null {
  const exit = detailForJob(detailsByJob, slot.jobId).exit;
  if (!exit || phaseForOutcome(exit.outcome) !== 'completed') {
    return null;
  }
  return exit.content;
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
      return outcome !== undefined && phaseForOutcome(outcome) !== 'completed';
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
  const completionRow = readLatestEvent(deps.db, deps.workflowId, 'workflow.completed');
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
  validateDurableSlotRelations(deps, compiledSlots, slotDetailsByJob);
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

function isNeverLaunchedSlot(deps: ResumeWorkflowDeps, snapshot: RecoverySnapshot, slot: CompiledPlanSlot): boolean {
  const projection = readProjectionJob(deps.db, slot.jobId);
  const detail = detailForJob(snapshot.slotDetailsByJob, slot.jobId);
  return projection === null && detail.status === null;
}

function classifyActiveStepLaunchState(deps: ResumeWorkflowDeps, snapshot: RecoverySnapshot): ActiveStepLaunchState {
  const neverLaunchedSlots = snapshot.stepSlots.filter((slot) => isNeverLaunchedSlot(deps, snapshot, slot));
  if (neverLaunchedSlots.length === 0) {
    return { kind: 'all-launched', neverLaunchedSlots: [] };
  }
  if (neverLaunchedSlots.length === snapshot.stepSlots.length) {
    return { kind: 'all-never-launched', neverLaunchedSlots };
  }
  return { kind: 'mixed', neverLaunchedSlots };
}

function atomIndexForSlot(snapshot: RecoverySnapshot, slot: CompiledPlanSlot): number {
  const atomIndex = snapshot.stepSlots.findIndex((candidate) => candidate.slotId === slot.slotId);
  if (atomIndex < 0) {
    throw new Error(`Workflow recovery could not place slot '${slot.slotId}' in its active step.`);
  }
  return atomIndex;
}

function runRecoveryWaitForAtoms(
  deps: ResumeWorkflowDeps,
  atoms: LaunchedAtom[],
  extra: { initialState?: Partial<WaitInternalState>; completedStepDetails: StepDetail[] },
): Promise<Map<string, string>> {
  return waitForAtoms(atoms, deps.executionSvc, deps.ctx, {
    staleTimeoutMs: deps.staleTimeoutMs,
    staleCheckIntervalMs: deps.staleCheckIntervalMs,
    staleAbortTimeoutMs: deps.staleAbortTimeoutMs,
    drainDeadlineMs: deps.drainDeadlineMs,
    ...(extra.initialState === undefined ? {} : { initialState: extra.initialState }),
    completedStepDetails: extra.completedStepDetails,
    workflowJobId: deps.workflowId,
    onProgress: (message) => deps.onProgress(deps.workflowId, message),
    time: deps.time,
    recoverStaleAtom,
  });
}

async function drainLaunchedRecoveryAtoms(deps: ResumeWorkflowDeps, atoms: LaunchedAtom[]): Promise<StepDetail[]> {
  if (atoms.length === 0) return [];

  deps.executionSvc.abort(atoms.map((atom) => atom.jobId));
  try {
    const results = await runRecoveryWaitForAtoms(deps, atoms, { completedStepDetails: [] });
    return buildStepDetailsForAtoms(atoms, results);
  } catch (error) {
    if (error instanceof WorkflowExecutionError) {
      return error.stepDetails;
    }
    throw error;
  }
}

function mergeActiveAtomsWithLaunched(
  stepSlots: readonly CompiledPlanSlot[],
  activeAtoms: LaunchedAtom[],
  launchedAtoms: LaunchedAtom[],
): LaunchedAtom[] {
  const atomsBySlot = new Map([...activeAtoms, ...launchedAtoms].map((atom) => [atom.slotId, atom]));
  return stepSlots.map((slot) => {
    const atom = atomsBySlot.get(slot.slotId);
    if (atom === undefined) {
      throw new Error(`Workflow recovery has no launched atom for slot '${slot.slotId}'.`);
    }
    return atom;
  });
}

async function recoverPartiallyLaunchedStep(
  deps: ResumeWorkflowDeps,
  snapshot: RecoverySnapshot,
  neverLaunchedSlots: readonly CompiledPlanSlot[],
): Promise<RecoveredWorkflowFinalization> {
  const waitPlan = buildWaitRecoveryPlan(deps, snapshot);
  const blocked = blockingFailureFinalization(deps.workflowId, snapshot.summary, waitPlan.blockingFailure);
  if (blocked !== null) return blocked;

  deps.onProgress(deps.workflowId, `resuming partially launched step ${snapshot.summary.activeStepIndex}`);

  const neverLaunchedSlotIds = new Set(neverLaunchedSlots.map((slot) => slot.slotId));
  const launchedPending = waitPlan.activeAtoms.filter((atom) => !neverLaunchedSlotIds.has(atom.slotId));
  const { launchedAtoms, launchError } = await launchCompiledStepAtoms(
    neverLaunchedSlots,
    snapshot.summary.stepPrompt,
    deps.executionSvc,
    deps.ctx,
    {
      completedStepDetails: snapshot.summary.stepDetails,
      workflowJobId: deps.workflowId,
      atomIndexFor: (slot) => atomIndexForSlot(snapshot, slot),
    },
  );
  if (launchError !== null) {
    const drainAtoms = [...launchedPending, ...launchedAtoms];
    await handleStepLaunchFailure(launchError, drainAtoms, {
      completedStepDetails: snapshot.summary.stepDetails,
      drainLaunchedAtoms: () => drainLaunchedRecoveryAtoms(deps, drainAtoms),
    });
  }

  const hybridPlan: WaitRecoveryPlan = {
    ...waitPlan,
    activeAtoms: mergeActiveAtomsWithLaunched(snapshot.stepSlots, waitPlan.activeAtoms, launchedAtoms),
  };
  const stepResults = await runRecoveryWaitForAtoms(deps, hybridPlan.activeAtoms, {
    initialState: hybridPlan.initialState,
    completedStepDetails: snapshot.summary.stepDetails,
  });
  return continueAfterRecoveredStep(deps, snapshot.summary, hybridPlan, stepResults);
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
  const drainRow = readLatestEvent(deps.db, deps.workflowId, 'workflow.drain.entered');
  const drain = drainRow ? decodeBody(drainRow, workflowDrainEnteredBodySchema, snapshot.readCtx) : null;

  for (const slot of snapshot.stepSlots) {
    const detail = detailForJob(snapshot.slotDetailsByJob, slot.jobId);
    if (detail.exit && phaseForOutcome(detail.exit.outcome) === 'completed') {
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
  const stepResults = await runRecoveryWaitForAtoms(deps, plan.activeAtoms, {
    initialState: plan.initialState,
    completedStepDetails: snapshot.summary.stepDetails,
  });
  return continueAfterRecoveredStep(deps, snapshot.summary, plan, stepResults);
}

async function resumeWorkflow(deps: ResumeWorkflowDeps): Promise<RecoveredWorkflowFinalization | null> {
  if (detectExistingCompletion(deps)) {
    return null;
  }

  await resumePendingReplacementIntents(deps);

  const snapshot = loadRecoverySnapshot(deps);
  if (snapshot.summary.activeStepIndex > maxStepIndex(deps.plan)) {
    return completedFinalization(deps, snapshot.summary);
  }

  const launchState = classifyActiveStepLaunchState(deps, snapshot);
  if (launchState.kind === 'mixed') {
    return recoverPartiallyLaunchedStep(deps, snapshot, launchState.neverLaunchedSlots);
  }

  if (launchState.kind === 'all-never-launched') {
    return assembleRelaunch(deps, snapshot.summary);
  }

  return waitAndFinalize(deps, snapshot);
}

export async function resumeAll(options: {
  db: Database;
  progressStore: Pick<JobStore, 'listJobIds' | 'readStatus' | 'readLaunchProjection'> & StoreReadContext;
  loadJobDetails: LoadJobDetailsFn;
  getExecutionService: (ctx: InvocationContext) => WorkflowExecutionPort;
  createInvocationContext: (projectRoot: string) => InvocationContext;
  finalizeWorkflow: (intent: WorkflowFinalizationIntent) => void;
  releaseFailedWorkflowDescendants: (workflowId: string) => readonly WorkflowRecoveryDescendantRelease[];
  log?: (message: string) => void;
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

    let recovered: RecoveredWorkflowFinalization | null;
    let containedFailure: { error: unknown } | null = null;
    try {
      const projection = readWorkflowProjection(options.db, jobId);
      if (!projection) {
        const error = new Error('Workflow recovery could not find a workflow projection.');
        containedFailure = { error };
        recovered = { intent: recoveryIntentFromError(jobId, error) };
      } else {
        const baseCtx = options.createInvocationContext(status.projectRoot);
        const ctx: InvocationContext = {
          ...baseCtx,
          providerScope: projection.providerScope,
        };
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
      }
    } catch (error: unknown) {
      if (isAbortError(error)) {
        throw error;
      }
      containedFailure = { error };
      recovered = { intent: recoveryIntentFromError(jobId, error) };
    }

    if (recovered === null) {
      continue;
    }

    options.finalizeWorkflow(recovered.intent);
    if (containedFailure !== null) {
      const releasedDescendants = options.releaseFailedWorkflowDescendants(jobId);
      for (const released of releasedDescendants) {
        options.log?.(
          `Workflow recovery child ${released.jobId} session claim ${released.sessionId} disposition: ${describeSessionJobClaimReleaseResult(released.sessionClaimRelease)}.\n`,
        );
      }
      const outcomeDescription =
        recovered.intent.outcome === 'failed'
          ? 'after recovery failed'
          : `with ${recovered.intent.outcome} outcome after recovery error`;
      options.log?.(
        `Workflow recovery finalized ${jobId} ${outcomeDescription}: ${errorMessage(containedFailure.error)}\n`,
      );
    }
    if (recovered.error) {
      options.log?.(
        `Workflow recovery finalized ${jobId} with ${recovered.intent.outcome} outcome: ${errorMessage(recovered.error)}\n`,
      );
    }
    resumedWorkflowIds.push(jobId);
  }

  return resumedWorkflowIds;
}

export const workflowRecover = {
  resumeAll,
} as const;
