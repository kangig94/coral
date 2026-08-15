import type { Database } from '../store/db.js';

import { errorMessage } from '../infra/error-format.js';
import { describeSessionJobClaimReleaseResult } from '../sessions/job-release.js';
import type { SessionJobClaimReleaseResult } from '../sessions/contracts.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import { canonicalizeWorkDir, type CanonicalWorkDir } from '../runtime/canonical-work-dir.js';
import type { IdPort } from '../runtime/ports.js';
import type { TimePort } from '../infra/port-types.js';
import { nowIsoString } from '../infra/time.js';
import type { JobTerminal } from '../jobs/records.js';
import type { CauseRef } from '../causality/cause-ref.js';
import { phaseForOutcome, type TerminalOutcome } from '../jobs/outcome.js';
import { hydrateJobRecoveryProjection } from '../jobs/store.js';
import { decodeBody, type StoreReadContext } from '../store/body-codec.js';
import type { JobProjectionDetail } from '../jobs/read-queries.js';
import { hydrateWorkflowProjectionRow, type WorkflowProjectionRow } from './read-queries.js';
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
import {
  compileWorkflowPlan,
  maxStepIndex,
  resolveWorkflowJobIds,
  type CompiledPlanSlot,
  type WorkflowPlan,
} from './plan.js';
import { DEFAULT_STALE_ABORT_TIMEOUT_MS, recoverStaleAtom, STALE_RESUME_PROMPT } from './stale-recovery.js';

import { waitForAtoms } from './wait.js';
import type { WorkflowFinalizationIntent } from './finalization.js';
import {
  providerSessionProvider,
  providerSessionSchema,
  sessionControllerFromProfile,
  type ProviderSession,
} from '../sessions/entry.js';
import { projectionSessionStoredRowSchema, readProjectionProviderSession } from '../sessions/projections.js';
import type { ProjectionJobStoredRow } from '../jobs/projection-row.js';
import type {
  RecoveryDisposition,
  RecoveryObligationId,
  RecoveryQuarantinePort,
  RecoverySettlementFact,
  RecoverySubject,
} from '../recovery/containment.js';
import type { RecoveryRetryPolicy, RecoverySourceFactoryPlan } from '../recovery/source-registry.js';
import { RecoveryQuarantineStore } from '../recovery/quarantine.js';
import { workflowRecoverySource, type RawWorkflowRecoveryEnvelope } from './recovery-source.js';
import { runWorkflowStartupRecovery } from './startup-recovery.js';
import { rowToCoralEvent } from '../store/envelope.js';
import type { EventsRow } from '../store/schema.js';
import type { CommitContext } from '../store/append.js';

type WorkflowSlotJobRow = ProjectionJobStoredRow & { workflow_slot: string };

type RecoveredWorkflowFinalization = {
  intent: WorkflowFinalizationIntent;
  error?: WorkflowExecutionError;
};

export type WorkflowRecoveryDescendant = {
  readonly jobId: string;
  readonly sessionId: string;
  readonly projectRoot: CanonicalWorkDir;
};

export type WorkflowRecoveryDescendantRelease = {
  jobId: string;
  sessionId: string;
  sessionClaimRelease: SessionJobClaimReleaseResult;
};

export type WorkflowRecoveryAtomicClose = {
  readonly intent: WorkflowFinalizationIntent;
  readonly recording: {
    readonly namespace?: string;
    readonly project?: string;
    readonly startedAt: string;
  };
  readonly descendants: readonly WorkflowRecoveryDescendant[];
  readonly releaseDescendants: AtomicFailedWorkflowDescendantReleaser;
  clearContinuation(): boolean;
};

export type WorkflowRecoveryFinalizer = ((intent: WorkflowFinalizationIntent) => void) & {
  atomicClose?(request: WorkflowRecoveryAtomicClose): readonly WorkflowRecoveryDescendantRelease[];
};

export type FailedWorkflowDescendantReleaser = ((
  workflowId: string,
) => readonly WorkflowRecoveryDescendantRelease[]) & {
  composeAtomic?<Scope>(
    commit: CommitContext<Scope>,
    descendants: readonly WorkflowRecoveryDescendant[],
  ): readonly WorkflowRecoveryDescendantRelease[];
  cleanup?(descendants: readonly WorkflowRecoveryDescendant[]): void;
};

export type AtomicFailedWorkflowDescendantReleaser = FailedWorkflowDescendantReleaser & {
  composeAtomic<Scope>(
    commit: CommitContext<Scope>,
    descendants: readonly WorkflowRecoveryDescendant[],
  ): readonly WorkflowRecoveryDescendantRelease[];
  cleanup(descendants: readonly WorkflowRecoveryDescendant[]): void;
};

type ResumeWorkflowContext = {
  progressStore: StoreReadContext;
  executionSvc: WorkflowExecutionPort;
  ctx: InvocationContext;
  workflowId: string;
  plan: WorkflowPlan;
  childRows: readonly ProjectionJobStoredRow[];
  slotDetailsByJob: Map<string, JobProjectionDetail>;
  providerSessionsById: ReadonlyMap<string, ProviderSession>;
  eventsBySeq: ReadonlyMap<number, EventsRow>;
  completion: ReturnType<typeof workflowCompletedBodySchema.parse> | null;
  drain: ReturnType<typeof workflowDrainEnteredBodySchema.parse> | null;
  time: Pick<TimePort, 'now'>;
  onProgress: (workflowId: string, message: string) => void;
  /**
   * A mandatory checkpoint, not a notification: recovery may not proceed past a committed replacement
   * until the durable continuation names it. The continuation was read before this pass created
   * anything, and the close can only release what it names.
   */
  checkpointReplacement: (sessionId: string, jobId: string) => Promise<void>;
  staleTimeoutMs: number;
  staleCheckIntervalMs: number;
  staleAbortTimeoutMs: number;
  drainDeadlineMs: number;
};

type ResumeWorkflowDeps = ResumeWorkflowContext & {
  jobIds: ReadonlyMap<string, string>;
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

type WorkflowRecoveryContinuation = {
  readonly workflowId: string;
  readonly sourceRevision: string;
  readonly childIds: readonly string[];
  readonly providerSessions: readonly {
    readonly sessionId: string;
    readonly projectRoot: CanonicalWorkDir;
    readonly version: number;
    readonly activeJobId: string | null;
    readonly continuationLease: ProviderSession['continuationLease'] | null;
  }[];
  readonly stage: 'prepared' | 'external-outcome-unknown' | 'ready-to-close';
  readonly intendedFinalization:
    | { readonly kind: 'pending' }
    | { readonly kind: 'intent'; readonly intent: WorkflowFinalizationIntent };
  readonly completedObligations: readonly string[];
};

type HydratedWorkflowRecovery = {
  readonly envelope: RawWorkflowRecoveryEnvelope;
  readonly rootDetail: JobProjectionDetail;
  readonly rootProjectRoot: CanonicalWorkDir;
  readonly projection: WorkflowProjectionRow | null;
  readonly childRows: readonly ProjectionJobStoredRow[];
  readonly slotDetailsByJob: Map<string, JobProjectionDetail>;
  readonly providerSessionsById: ReadonlyMap<string, ProviderSession>;
  readonly completion: ReturnType<typeof workflowCompletedBodySchema.parse> | null;
  readonly drain: ReturnType<typeof workflowDrainEnteredBodySchema.parse> | null;
  readonly eventsBySeq: ReadonlyMap<number, EventsRow>;
  continuation: WorkflowRecoveryContinuation;
  readonly continuationRecovered: boolean;
  continuationDurable: boolean;
  closeCompleted: boolean;
  cleanupRequired: boolean;
  deferredReason: 'unknown-external' | 'close-failed' | null;
  recoveredError: unknown;
  descendantReleases: readonly WorkflowRecoveryDescendantRelease[];
};

const WORKFLOW_RECOVERY_CONTINUATION_KIND = 'workflow-recovery.v1';
const RESUME_OBLIGATION = 'workflow-recovery.resume' as RecoveryObligationId;
const FINALIZE_OBLIGATION = 'workflow-recovery.finalize' as RecoveryObligationId;
const DESCENDANT_RELEASE_OBLIGATION = 'workflow-recovery.descendant-release' as RecoveryObligationId;

class UnknownWorkflowRecoveryOutcome extends Error {
  readonly cause: unknown;

  constructor(action: string, cause: unknown) {
    super(`Workflow recovery ${action} outcome is unknown: ${errorMessage(cause)}`);
    this.name = 'UnknownWorkflowRecoveryOutcome';
    this.cause = cause;
  }
}

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

function validateAndReadCurrentSlotJobIds(
  rows: readonly ProjectionJobStoredRow[],
  workflowId: string,
  plan: WorkflowPlan,
): ReadonlyMap<string, string> {
  const slotIds = new Set<string>();
  for (const slot of plan.slots) {
    slotIds.add(slot.slotId);
  }
  const workflowRows = rows
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

  for (const row of workflowRows) {
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

async function resumePendingReplacementIntents(
  deps: ResumeWorkflowContext,
  slotJobs: ReadonlyMap<string, string>,
): Promise<ReadonlyMap<string, string>> {
  const replacementJobIds = new Map<string, string>();
  const details = deps.slotDetailsByJob;
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
    const session = deps.providerSessionsById.get(launch.sessionId);
    if (session === undefined) {
      throw new Error(`Session not found: ${launch.sessionId}`);
    }
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
        cwd: canonicalizeWorkDir(launch.request.cwd, deps.ctx.projectRoot),
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
    // Before any further fallible work — `awaitLaunch` below is the first thing that can throw, and the
    // close that follows a throw can only release what the continuation names. Recording here is what
    // keeps a replacement this pass created inside the envelope this pass cleans up.
    await deps.checkpointReplacement(launch.sessionId, resumed.jobId);

    const readiness = await deps.executionSvc.awaitLaunch(resumed.jobId, BOOTSTRAP_TIMEOUT_MS);
    if (readiness === 'error') {
      throw new Error(`Workflow recovery replacement '${resumed.jobId}' failed to launch for slot '${slot.slotId}'.`);
    }
    replacementJobIds.set(slot.slotId, resumed.jobId);
    deps.slotDetailsByJob.set(resumed.jobId, {
      status: {
        ...(detail.status ?? {
          owner: { kind: 'workflow', id: deps.workflowId },
          sessionId: launch.sessionId,
          provider: launch.provider,
          projectRoot: launch.projectRoot,
          backendNamespace: launch.backendNamespace,
          jobKind: 'provider' as const,
          updatedAt: launch.createdAt,
          lastSeq: 0,
        }),
        jobId: resumed.jobId,
        phase: 'running',
      },
      launch: {
        ...launch,
        jobId: resumed.jobId,
        workflowSlotGeneration: nextGeneration,
        replacesWorkflowJobId: jobId,
      },
      runtime: null,
      exit: null,
    });
  }
  return replacementJobIds;
}

async function resolveWorkflowRecoveryJobIds(
  deps: ResumeWorkflowContext,
  currentSlotJobIds: ReadonlyMap<string, string>,
  ids: Pick<IdPort, 'uuid'>,
): Promise<ReadonlyMap<string, string>> {
  const replacementJobIds = await resumePendingReplacementIntents(deps, currentSlotJobIds);
  return resolveWorkflowJobIds(deps.plan, ids, new Map([...currentSlotJobIds, ...replacementJobIds]));
}

function replacementRecoveryLeaseExpiresAt(deps: ResumeWorkflowContext): string {
  const minimumTtlMs = 60_000;
  return nowIsoString(deps.time.now() + Math.max(minimumTtlMs, deps.staleAbortTimeoutMs + BOOTSTRAP_TIMEOUT_MS));
}

function isRecoverableReplacementCrash(deps: ResumeWorkflowContext, outcome: TerminalOutcome): boolean {
  if (outcome.kind === 'aborted') return true;
  if (outcome.kind === 'job_fault') {
    return outcome.fault.kind === 'ghost_launch' || outcome.fault.kind === 'wrapper_lost';
  }
  if (outcome.kind !== 'failed') return false;

  const cause = deps.eventsBySeq.get(outcome.causeRef.seq);
  return (
    cause?.stream_kind === outcome.causeRef.stream.kind &&
    cause.stream_id === outcome.causeRef.stream.id &&
    cause.type === 'session.interrupted'
  );
}

function compileSlotsForRecovery(deps: ResumeWorkflowDeps): CompiledPlanSlot[] {
  return compileWorkflowPlan(deps.plan, {
    jobIds: deps.jobIds,
  });
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
  const projectionsByJob = new Map(deps.childRows.map((row) => [row.job_id, row]));
  for (const slot of slots) {
    if (!projectionsByJob.has(slot.jobId)) continue;

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

    const session = deps.providerSessionsById.get(launch.sessionId);
    if (session === undefined) {
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

function detectExistingCompletion(deps: ResumeWorkflowContext): boolean {
  return deps.completion !== null;
}

function loadRecoverySnapshot(deps: ResumeWorkflowDeps): RecoverySnapshot {
  const readCtx: StoreReadContext = deps.progressStore;
  const compiledSlots = compileSlotsForRecovery(deps);
  const slotDetailsByJob = deps.slotDetailsByJob;
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
  const projection = deps.childRows.find((row) => row.job_id === slot.jobId) ?? null;
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
    jobIds: deps.jobIds,
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
  const drain = deps.drain;
  const projectionsByJob = new Map(deps.childRows.map((row) => [row.job_id, row]));

  for (const slot of snapshot.stepSlots) {
    const detail = detailForJob(snapshot.slotDetailsByJob, slot.jobId);
    if (detail.exit && phaseForOutcome(detail.exit.outcome) === 'completed') {
      completedOutputs.set(slot.atomKey, detail.exit.content);
      continue;
    }

    const projection = projectionsByJob.get(slot.jobId);
    if (projection) {
      pendingCursorSeq =
        pendingCursorSeq === null ? projection.last_seq : Math.min(pendingCursorSeq, projection.last_seq);
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

async function resumeWorkflow(
  context: ResumeWorkflowContext,
  currentSlotJobIds: ReadonlyMap<string, string>,
  ids: Pick<IdPort, 'uuid'>,
): Promise<RecoveredWorkflowFinalization | null> {
  if (detectExistingCompletion(context)) {
    return null;
  }
  const deps: ResumeWorkflowDeps = {
    ...context,
    jobIds: await resolveWorkflowRecoveryJobIds(context, currentSlotJobIds, ids),
  };

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

function latestEvent(events: readonly EventsRow[], type: string): EventsRow | null {
  let latest: EventsRow | null = null;
  for (const event of events) {
    if (event.type === type && (latest === null || event.seq > latest.seq)) latest = event;
  }
  return latest;
}

function asRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseWorkflowRecoveryContinuation(envelope: RawWorkflowRecoveryEnvelope): WorkflowRecoveryContinuation | null {
  const raw = envelope.continuation;
  if (raw === null) return null;
  if (raw.continuation_kind !== WORKFLOW_RECOVERY_CONTINUATION_KIND || raw.continuation_key === null) {
    throw new TypeError(`Workflow '${envelope.job.projection.job_id}' has an invalid recovery continuation.`);
  }
  const parsed = asRecord(
    JSON.parse(raw.continuation_key) as unknown,
    `Workflow '${envelope.job.projection.job_id}' recovery continuation`,
  );
  const workflowId = parsed.workflowId;
  const sourceRevision = parsed.sourceRevision;
  const childIds = parsed.childIds;
  const providerSessions = parsed.providerSessions;
  const stage = parsed.stage;
  const intendedFinalization = asRecord(parsed.intendedFinalization, 'Workflow intended finalization');
  const completedObligations = parsed.completedObligations;
  if (
    workflowId !== envelope.job.projection.job_id ||
    typeof sourceRevision !== 'string' ||
    !Array.isArray(childIds) ||
    childIds.some((value) => typeof value !== 'string') ||
    new Set(childIds).size !== childIds.length ||
    !Array.isArray(providerSessions) ||
    !Array.isArray(completedObligations) ||
    completedObligations.some((value) => typeof value !== 'string') ||
    new Set(completedObligations).size !== completedObligations.length ||
    (stage !== 'prepared' && stage !== 'external-outcome-unknown' && stage !== 'ready-to-close') ||
    (intendedFinalization.kind !== 'pending' && intendedFinalization.kind !== 'intent')
  ) {
    throw new TypeError(`Workflow '${envelope.job.projection.job_id}' recovery continuation is malformed.`);
  }
  if (intendedFinalization.kind === 'intent') {
    const intent = asRecord(intendedFinalization.intent, 'Workflow recovery finalization intent');
    if (
      intent.workflowJobId !== workflowId ||
      (intent.outcome !== 'completed' && intent.outcome !== 'failed' && intent.outcome !== 'aborted')
    ) {
      throw new TypeError(`Workflow '${workflowId}' recovery continuation has an invalid finalization intent.`);
    }
  }
  for (const value of providerSessions) {
    const session = asRecord(value, 'Workflow recovery provider-session reference');
    if (
      typeof session.sessionId !== 'string' ||
      typeof session.projectRoot !== 'string' ||
      typeof session.version !== 'number' ||
      !Number.isInteger(session.version) ||
      !(session.activeJobId === null || (typeof session.activeJobId === 'string' && session.activeJobId.length > 0))
    ) {
      throw new TypeError(`Workflow '${workflowId}' recovery continuation has an invalid session reference.`);
    }
  }
  const sessionIds = providerSessions.map(
    (value) => asRecord(value, 'Workflow recovery provider-session reference').sessionId,
  );
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw new TypeError(`Workflow '${workflowId}' recovery continuation repeats a session reference.`);
  }
  const canonicalProviderSessions = providerSessions.map((value) => {
    const session = asRecord(value, 'Workflow recovery provider-session reference');
    return {
      sessionId: session.sessionId as string,
      projectRoot: canonicalizeWorkDir(session.projectRoot as string, process.cwd()),
      version: session.version as number,
      activeJobId: session.activeJobId as string | null,
      continuationLease: session.continuationLease as ProviderSession['continuationLease'] | null,
    };
  });
  const finalization =
    intendedFinalization.kind === 'pending'
      ? ({ kind: 'pending' } as const)
      : ({
          kind: 'intent',
          intent: intendedFinalization.intent as WorkflowFinalizationIntent,
        } as const);
  return {
    workflowId,
    sourceRevision,
    childIds: childIds as string[],
    providerSessions: canonicalProviderSessions,
    stage,
    intendedFinalization: finalization,
    completedObligations: completedObligations as string[],
  };
}

function initialWorkflowContinuation(
  envelope: RawWorkflowRecoveryEnvelope,
  providerSessionsById: ReadonlyMap<string, ProviderSession>,
  slotDetailsByJob: ReadonlyMap<string, JobProjectionDetail>,
  rootProjectRoot: CanonicalWorkDir,
): WorkflowRecoveryContinuation {
  const projectRootsBySession = new Map<string, CanonicalWorkDir>();
  for (const detail of slotDetailsByJob.values()) {
    const status = detail.status;
    if (status?.sessionId !== null && status?.sessionId !== undefined) {
      projectRootsBySession.set(status.sessionId, canonicalizeWorkDir(status.projectRoot, process.cwd()));
    }
  }
  return {
    workflowId: envelope.job.projection.job_id,
    sourceRevision: envelope.sourceRevision.value,
    childIds: envelope.children.map((child) => child.projection.job_id),
    providerSessions: [...providerSessionsById.values()]
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
      .map((session) => ({
        sessionId: session.sessionId,
        projectRoot: projectRootsBySession.get(session.sessionId) ?? rootProjectRoot,
        version: session.version,
        activeJobId: session.activeJobId ?? null,
        continuationLease: session.continuationLease ?? null,
      })),
    stage: 'prepared',
    intendedFinalization: { kind: 'pending' },
    completedObligations: [],
  };
}

function continuationDescendants(continuation: WorkflowRecoveryContinuation): readonly WorkflowRecoveryDescendant[] {
  const childIds = new Set(continuation.childIds);
  return continuation.providerSessions.flatMap((session) =>
    session.activeJobId !== null && childIds.has(session.activeJobId)
      ? [
          {
            jobId: session.activeJobId,
            sessionId: session.sessionId,
            projectRoot: session.projectRoot,
          },
        ]
      : [],
  );
}

function hydrateWorkflowRecovery(raw: RawWorkflowRecoveryEnvelope, ctx: StoreReadContext): HydratedWorkflowRecovery {
  const rootDetail = hydrateJobRecoveryProjection(raw.job, ctx);
  const rootStatus = rootDetail.status;
  if (rootStatus === null || rootStatus.jobKind !== 'workflow') {
    throw new TypeError(`Workflow recovery root '${raw.job.projection.job_id}' is not a workflow job.`);
  }
  const rootProjectRoot = canonicalizeWorkDir(rootStatus.projectRoot, process.cwd());
  const projection = raw.workflow === null ? null : hydrateWorkflowProjectionRow(raw.workflow);
  if (projection !== null && projection.workflowId !== rootStatus.jobId) {
    throw new TypeError(`Workflow recovery projection '${projection.workflowId}' names another root.`);
  }

  const childRows: ProjectionJobStoredRow[] = [];
  const slotDetailsByJob = new Map<string, JobProjectionDetail>();
  for (const child of raw.children) {
    const detail = hydrateJobRecoveryProjection(child, ctx);
    childRows.push(child.projection);
    slotDetailsByJob.set(child.projection.job_id, detail);
  }

  const providerSessionsById = new Map<string, ProviderSession>();
  for (const sessionRow of raw.providerSessions) {
    const row = projectionSessionStoredRowSchema.parse(sessionRow);
    const entry = providerSessionSchema.parse(JSON.parse(row.entry) as unknown);
    if (
      entry.sessionId !== row.session_id ||
      sessionControllerFromProfile(entry.controllerProfile) !== row.controller ||
      (entry.state === 'ready' ? 1 : 0) !== row.resumable ||
      (entry.conversationRef ?? null) !== row.conversation_ref
    ) {
      throw new TypeError(`Workflow recovery provider session '${row.session_id}' contradicts its projection.`);
    }
    if (providerSessionsById.has(row.session_id)) {
      throw new TypeError(`Workflow recovery repeats provider session '${row.session_id}'.`);
    }
    providerSessionsById.set(row.session_id, entry);
  }

  const eventsBySeq = new Map<number, EventsRow>();
  for (const event of [...raw.job.events, ...raw.workflowEvents, ...raw.sessionEvents]) {
    rowToCoralEvent(event, null);
    if (eventsBySeq.has(event.seq)) {
      throw new TypeError(`Workflow recovery repeats event sequence '${event.seq}'.`);
    }
    eventsBySeq.set(event.seq, event);
  }
  for (const child of raw.children) {
    for (const event of child.events) {
      if (eventsBySeq.has(event.seq)) {
        throw new TypeError(`Workflow recovery repeats event sequence '${event.seq}'.`);
      }
      eventsBySeq.set(event.seq, event);
    }
  }
  const completionRow = latestEvent(raw.workflowEvents, 'workflow.completed');
  const drainRow = latestEvent(raw.workflowEvents, 'workflow.drain.entered');
  const completion = completionRow === null ? null : decodeBody(completionRow, workflowCompletedBodySchema, ctx);
  const drain = drainRow === null ? null : decodeBody(drainRow, workflowDrainEnteredBodySchema, ctx);
  const recoveredContinuation = parseWorkflowRecoveryContinuation(raw);
  const continuation =
    recoveredContinuation ?? initialWorkflowContinuation(raw, providerSessionsById, slotDetailsByJob, rootProjectRoot);
  return {
    envelope: raw,
    rootDetail,
    rootProjectRoot,
    projection,
    childRows,
    slotDetailsByJob,
    providerSessionsById,
    completion,
    drain,
    eventsBySeq,
    continuation,
    continuationRecovered: recoveredContinuation !== null,
    continuationDurable: recoveredContinuation !== null,
    closeCompleted: false,
    cleanupRequired: false,
    deferredReason: null,
    recoveredError: undefined,
    descendantReleases: [],
  };
}

function continuationToken(item: HydratedWorkflowRecovery): { kind: string; key: string } {
  return {
    kind: WORKFLOW_RECOVERY_CONTINUATION_KIND,
    key: JSON.stringify(item.continuation),
  };
}

async function persistWorkflowContinuation(
  item: HydratedWorkflowRecovery,
  quarantine: RecoveryQuarantinePort,
): Promise<void> {
  const persisted = await quarantine.upsert({
    boundary: 'workflow-recovery',
    subject: item.envelope.subject,
    state: 'continuation',
    stage: 'settle',
    errorMessage: '',
    detail: 'workflow recovery settlement remains authoritative',
    continuation: continuationToken(item),
  });
  if (!persisted) {
    throw new Error(`Workflow recovery continuation lost authority for '${item.envelope.subject.key}'.`);
  }
  item.continuationDurable = true;
}

/**
 * Re-reads the session rather than trusting the launch decision: `resume()` reports which job it created,
 * not whether that job ended up holding the claim. Confirming it here is what makes the recorded child a
 * fact about durable state instead of an inference from a return value — and the version comes back with
 * it, so the continuation stays internally consistent with the projection it mirrors.
 */
async function checkpointReplacementInContinuation(
  item: HydratedWorkflowRecovery,
  quarantine: RecoveryQuarantinePort,
  db: Database,
  sessionId: string,
  jobId: string,
): Promise<void> {
  const entry = readProjectionProviderSession(db, sessionId);
  if (entry === null || entry.activeJobId !== jobId) {
    throw new Error(`Workflow recovery replacement '${jobId}' did not take the claim on session '${sessionId}'.`);
  }
  item.continuation = {
    ...item.continuation,
    childIds: item.continuation.childIds.includes(jobId)
      ? item.continuation.childIds
      : [...item.continuation.childIds, jobId],
    providerSessions: item.continuation.providerSessions.map((session) =>
      session.sessionId === sessionId ? { ...session, activeJobId: jobId, version: entry.version } : session,
    ),
  };
  await persistWorkflowContinuation(item, quarantine);
}

function executionWithUnknownOutcome(
  service: WorkflowExecutionPort,
  recordUnknown: (error: UnknownWorkflowRecoveryOutcome) => void,
): WorkflowExecutionPort {
  return {
    coralDispatch: async (...args) => {
      try {
        return await service.coralDispatch(...args);
      } catch (error) {
        const unknown = new UnknownWorkflowRecoveryOutcome('launch', error);
        recordUnknown(unknown);
        throw unknown;
      }
    },
    resume: async (...args) => {
      try {
        return await service.resume(...args);
      } catch (error) {
        const unknown = new UnknownWorkflowRecoveryOutcome('resume', error);
        recordUnknown(unknown);
        throw unknown;
      }
    },
    recordContinuationLease: (...args) => service.recordContinuationLease(...args),
    clearContinuationLease: (...args) => service.clearContinuationLease(...args),
    abort: (...args) => service.abort(...args),
    awaitLaunch: async (...args) => {
      try {
        return await service.awaitLaunch(...args);
      } catch (error) {
        const unknown = new UnknownWorkflowRecoveryOutcome('launch readiness', error);
        recordUnknown(unknown);
        throw unknown;
      }
    },
    waitStream: (...args) => service.waitStream(...args),
    waitForJobTerminal: (...args) => service.waitForJobTerminal(...args),
  };
}

function settledFacts(item: HydratedWorkflowRecovery): readonly RecoverySettlementFact[] {
  return [
    {
      obligation: RESUME_OBLIGATION,
      outcome: item.continuation.completedObligations.includes(RESUME_OBLIGATION) ? 'done' : 'not-applicable',
      authorityRef: `workflow:${item.envelope.subject.key}`,
    },
    {
      obligation: FINALIZE_OBLIGATION,
      outcome: item.closeCompleted ? 'done' : 'not-applicable',
      authorityRef: `workflow:${item.envelope.subject.key}`,
    },
    {
      obligation: DESCENDANT_RELEASE_OBLIGATION,
      outcome: item.closeCompleted ? 'done' : 'not-applicable',
      authorityRef: `workflow:${item.envelope.subject.key}:descendants`,
    },
  ];
}

function atomicReleaser(
  releaseDescendants: (workflowId: string) => readonly WorkflowRecoveryDescendantRelease[],
): AtomicFailedWorkflowDescendantReleaser | null {
  const candidate = releaseDescendants as FailedWorkflowDescendantReleaser;
  return candidate.composeAtomic === undefined || candidate.cleanup === undefined
    ? null
    : (candidate as AtomicFailedWorkflowDescendantReleaser);
}

type ResumeAllOptions = {
  db: Database;
  progressStore: StoreReadContext;
  loadJobDetails: unknown;
  getExecutionService: (ctx: InvocationContext) => WorkflowExecutionPort;
  createInvocationContext: (projectRoot: CanonicalWorkDir) => InvocationContext;
  finalizeWorkflow: (intent: WorkflowFinalizationIntent) => void;
  releaseFailedWorkflowDescendants: (workflowId: string) => readonly WorkflowRecoveryDescendantRelease[];
  signal?: AbortSignal;
  log?: (message: string) => void;
  onProgress?: (workflowId: string, message: string) => void;
  staleTimeoutMs?: number;
  staleCheckIntervalMs?: number;
  staleAbortTimeoutMs?: number;
  drainDeadlineMs?: number;
  ids: Pick<IdPort, 'uuid'>;
  time: Pick<TimePort, 'now'>;
};

const workflowRetryOptions = new WeakMap<Database, ResumeAllOptions>();

function finalizationRecording(item: HydratedWorkflowRecovery): WorkflowRecoveryAtomicClose['recording'] {
  const status = item.rootDetail.status;
  const runtime = item.rootDetail.runtime;
  if (status === null || runtime?.transport !== 'workflow') {
    throw new Error(`Workflow '${item.envelope.subject.key}' has no workflow runtime start.`);
  }
  if (!Number.isFinite(Date.parse(runtime.startTime))) {
    throw new Error(`Workflow '${item.envelope.subject.key}' has an invalid runtime start timestamp.`);
  }
  return {
    namespace: status.backendNamespace,
    project: status.projectRoot,
    startedAt: runtime.startTime,
  };
}

function clearWorkflowContinuation(item: HydratedWorkflowRecovery, quarantine: RecoveryQuarantineStore): boolean {
  return quarantine.delete({
    boundary: 'workflow-recovery',
    subject: item.envelope.subject,
  });
}

function closeRecoveredWorkflow(
  item: HydratedWorkflowRecovery,
  intent: WorkflowFinalizationIntent,
  options: ResumeAllOptions,
  quarantine: RecoveryQuarantineStore,
): void {
  item.deferredReason = 'close-failed';
  const releaseDescendants = atomicReleaser(options.releaseFailedWorkflowDescendants);
  const finalizer = options.finalizeWorkflow as WorkflowRecoveryFinalizer;
  if (finalizer.atomicClose !== undefined && releaseDescendants !== null) {
    item.descendantReleases = finalizer.atomicClose({
      intent,
      recording: finalizationRecording(item),
      descendants: continuationDescendants(item.continuation),
      releaseDescendants,
      clearContinuation: () => clearWorkflowContinuation(item, quarantine),
    });
    item.cleanupRequired = true;
  } else {
    options.finalizeWorkflow(intent);
    item.descendantReleases =
      intent.outcome === 'failed' || intent.outcome === 'aborted'
        ? options.releaseFailedWorkflowDescendants(item.envelope.subject.key)
        : [];
    if (!clearWorkflowContinuation(item, quarantine)) {
      throw new Error(`Workflow recovery continuation changed for '${item.envelope.subject.key}'.`);
    }
  }
  item.closeCompleted = true;
  item.deferredReason = null;
}

function settledWorkflowResult(
  item: HydratedWorkflowRecovery,
  detail: string,
): Extract<RecoveryDisposition, { kind: 'advanced' }> {
  return {
    kind: 'advanced',
    outcome: 'settled',
    facts: settledFacts(item),
    detail,
  };
}

async function settleWorkflowRecovery(
  item: HydratedWorkflowRecovery,
  options: ResumeAllOptions,
  quarantine: RecoveryQuarantineStore,
  resumedWorkflowIds: string[],
): Promise<RecoveryDisposition> {
  await persistWorkflowContinuation(item, quarantine);
  if (
    item.continuationRecovered &&
    (item.continuation.stage === 'prepared' || item.continuation.stage === 'external-outcome-unknown')
  ) {
    item.deferredReason = 'unknown-external';
    return {
      kind: 'deferred',
      continuation: continuationToken(item),
      detail: 'workflow external recovery outcome remains unknown',
    };
  }
  if (item.continuation.stage === 'ready-to-close' && item.continuation.intendedFinalization.kind === 'intent') {
    closeRecoveredWorkflow(item, item.continuation.intendedFinalization.intent, options, quarantine);
    resumedWorkflowIds.push(item.envelope.subject.key);
    return settledWorkflowResult(item, 'workflow recovery durable close settled');
  }

  let recovered: RecoveredWorkflowFinalization | null;
  let containedFailure: unknown = null;
  let unknownExternalOutcome: UnknownWorkflowRecoveryOutcome | null = null;
  try {
    const projection = item.projection;
    if (projection === null) {
      throw new Error('Workflow recovery could not find a workflow projection.');
    }
    const status = item.rootDetail.status;
    if (status === null) {
      throw new Error('Workflow recovery could not hydrate its root job status.');
    }
    const baseCtx = options.createInvocationContext(item.rootProjectRoot);
    const ctx: InvocationContext = { ...baseCtx, providerScope: projection.providerScope };
    const currentSlotJobIds = validateAndReadCurrentSlotJobIds(item.childRows, status.jobId, projection.plan);
    recovered = await resumeWorkflow(
      {
        progressStore: options.progressStore,
        executionSvc: executionWithUnknownOutcome(options.getExecutionService(ctx), (error) => {
          unknownExternalOutcome ??= error;
        }),
        ctx,
        workflowId: status.jobId,
        plan: projection.plan,
        childRows: item.childRows,
        slotDetailsByJob: item.slotDetailsByJob,
        providerSessionsById: item.providerSessionsById,
        eventsBySeq: item.eventsBySeq,
        completion: item.completion,
        drain: item.drain,
        onProgress: options.onProgress ?? (() => {}),
        checkpointReplacement: (sessionId, jobId) =>
          checkpointReplacementInContinuation(item, quarantine, options.db, sessionId, jobId),
        staleTimeoutMs: options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS,
        staleCheckIntervalMs: options.staleCheckIntervalMs ?? DEFAULT_STALE_CHECK_INTERVAL_MS,
        staleAbortTimeoutMs: options.staleAbortTimeoutMs ?? DEFAULT_STALE_ABORT_TIMEOUT_MS,
        drainDeadlineMs: options.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS,
        time: options.time,
      },
      currentSlotJobIds,
      options.ids,
    );
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the callback captures an Error subclass that TypeScript does not track across the await; preserve that exact instance
    if (unknownExternalOutcome !== null) throw unknownExternalOutcome;
  } catch (error: unknown) {
    options.signal?.throwIfAborted();
    const unknownOutcome = unknownExternalOutcome ?? (error instanceof UnknownWorkflowRecoveryOutcome ? error : null);
    if (unknownOutcome !== null) {
      item.recoveredError = unknownOutcome;
      item.deferredReason = 'unknown-external';
      item.continuation = {
        ...item.continuation,
        stage: 'external-outcome-unknown',
      };
      await persistWorkflowContinuation(item, quarantine);
      return {
        kind: 'deferred',
        continuation: continuationToken(item),
        detail: unknownOutcome.message,
      };
    }
    containedFailure = error;
    item.recoveredError = error;
    recovered = { intent: recoveryIntentFromError(item.envelope.subject.key, error) };
  }

  if (recovered === null) {
    if (!clearWorkflowContinuation(item, quarantine)) {
      throw new Error(`Workflow recovery continuation changed for '${item.envelope.subject.key}'.`);
    }
    return settledWorkflowResult(item, 'workflow already had a durable completion');
  }

  item.continuation = {
    ...item.continuation,
    stage: 'ready-to-close',
    intendedFinalization: { kind: 'intent', intent: recovered.intent },
    completedObligations: [RESUME_OBLIGATION],
  };
  await persistWorkflowContinuation(item, quarantine);
  closeRecoveredWorkflow(item, recovered.intent, options, quarantine);
  resumedWorkflowIds.push(item.envelope.subject.key);

  for (const released of item.descendantReleases) {
    options.log?.(
      `Workflow recovery child ${released.jobId} session claim ${released.sessionId} disposition: ${describeSessionJobClaimReleaseResult(released.sessionClaimRelease)}.\n`,
    );
  }
  if (containedFailure !== null) {
    const outcomeDescription =
      recovered.intent.outcome === 'failed'
        ? 'after recovery failed'
        : `with ${recovered.intent.outcome} outcome after recovery error`;
    options.log?.(
      `Workflow recovery finalized ${item.envelope.subject.key} ${outcomeDescription}: ${errorMessage(containedFailure)}\n`,
    );
  }
  if (recovered.error !== undefined) {
    options.log?.(
      `Workflow recovery finalized ${item.envelope.subject.key} with ${recovered.intent.outcome} outcome: ${errorMessage(recovered.error)}\n`,
    );
  }
  return settledWorkflowResult(item, 'workflow recovery finalized and descendant claims released');
}

function createWorkflowRecoveryPolicy(
  options: ResumeAllOptions,
  quarantine: RecoveryQuarantineStore,
  resumedWorkflowIds: string[],
): RecoveryRetryPolicy<RawWorkflowRecoveryEnvelope, HydratedWorkflowRecovery> {
  return {
    processLocalCleanup: {
      kind: 'boundary-required',
      release: (item) => {
        if (!item.cleanupRequired) return { kind: 'released' };
        const releaser = atomicReleaser(options.releaseFailedWorkflowDescendants);
        if (releaser === null) {
          return {
            kind: 'incomplete',
            error: new Error(`Workflow recovery has no descendant cleanup capability.`),
          };
        }
        try {
          releaser.cleanup(continuationDescendants(item.continuation));
          item.cleanupRequired = false;
          return { kind: 'released' };
        } catch (error) {
          return { kind: 'incomplete', error };
        }
      },
    },
    hydrate: (raw) => hydrateWorkflowRecovery(raw, options.progressStore),
    requiredObligations: () => [RESUME_OBLIGATION, FINALIZE_OBLIGATION, DESCENDANT_RELEASE_OBLIGATION],
    settle: (item) => settleWorkflowRecovery(item, options, quarantine, resumedWorkflowIds),
    onFault: (fault) => {
      if (fault.stage === 'scan') return { kind: 'fatal', error: fault.error };
      if (fault.stage === 'hydrate') {
        return { kind: 'quarantine', detail: 'workflow recovery hydration failed' };
      }
      if (
        fault.item.deferredReason === 'close-failed' ||
        (fault.item.deferredReason === 'unknown-external' && fault.item.continuationDurable)
      ) {
        return {
          kind: 'deferred',
          continuation: continuationToken(fault.item),
          detail:
            fault.item.deferredReason === 'close-failed'
              ? 'workflow recovery durable close remains pending'
              : 'workflow external recovery outcome remains unknown',
        };
      }
      return { kind: 'quarantine', detail: 'workflow recovery settlement failed before durable close' };
    },
  };
}

/** Returns the exact-subject workflow retry plan owned by workflow recovery. */
export function createWorkflowRecoveryRetryPlan(
  db: Database,
  subject: RecoverySubject,
): RecoverySourceFactoryPlan<RawWorkflowRecoveryEnvelope, HydratedWorkflowRecovery> {
  let resolvedPolicy: RecoveryRetryPolicy<RawWorkflowRecoveryEnvelope, HydratedWorkflowRecovery> | undefined;
  const policy = (): RecoveryRetryPolicy<RawWorkflowRecoveryEnvelope, HydratedWorkflowRecovery> => {
    if (resolvedPolicy === undefined) {
      const options = workflowRetryOptions.get(db);
      if (options === undefined) throw new Error('Workflow recovery retry policy is not initialized.');
      resolvedPolicy = createWorkflowRecoveryPolicy(options, new RecoveryQuarantineStore(db, options.time), []);
    }
    return resolvedPolicy;
  };
  return {
    source: workflowRecoverySource(db, subject),
    policy: {
      processLocalCleanup: {
        kind: 'boundary-required',
        release: (item) => {
          const cleanup = policy().processLocalCleanup;
          if (cleanup.kind !== 'boundary-required') {
            throw new Error('Workflow retry policy lost its cleanup contract.');
          }
          return cleanup.release(item);
        },
      },
      hydrate: (raw) => policy().hydrate(raw),
      requiredObligations: (item) => policy().requiredObligations(item),
      settle: (item) => policy().settle(item),
      onFault: (fault) => policy().onFault(fault),
    },
  };
}

export async function resumeAll(options: ResumeAllOptions): Promise<string[]> {
  const resumedWorkflowIds: string[] = [];
  const signal = options.signal ?? new AbortController().signal;
  const quarantine = new RecoveryQuarantineStore(options.db, options.time);
  workflowRetryOptions.set(options.db, options);
  await runWorkflowStartupRecovery<RawWorkflowRecoveryEnvelope, HydratedWorkflowRecovery>({
    source: workflowRecoverySource(options.db),
    policy: {
      signal,
      quarantine,
      ...createWorkflowRecoveryPolicy(options, quarantine, resumedWorkflowIds),
    },
  });
  return resumedWorkflowIds;
}

export const workflowRecover = {
  resumeAll,
} as const;
