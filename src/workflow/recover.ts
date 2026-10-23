import { z } from 'zod';
import { executionOrdinalSchema } from '../jobs/launch.js';
import type { RecoveryObservation } from '../recovery/phase-observation.js';
import type { Database } from '../store/db.js';

import { errorMessage } from '../infra/error-format.js';
import { canonicalizeWorkDir, WorkDirectoryError, type CanonicalWorkDir } from '../runtime/canonical-work-dir.js';
import type { IdPort } from '../runtime/ports.js';
import type { TimePort } from '../infra/port-types.js';
import type { JobTerminal } from '../jobs/records.js';
import type { CauseRef } from '../causality/cause-ref.js';
import { phaseForOutcome, type TerminalOutcome } from '../jobs/outcome.js';
import { hydrateJobRecoveryProjection } from '../jobs/store.js';
import { decodeBody, type StoreReadContext } from '../store/body-codec.js';
import type { JobProjectionDetail } from '../jobs/read-queries.js';
import { hydrateWorkflowProjectionRow, type WorkflowProjectionRow } from './read-queries.js';
import {
  buildStepDetailsForAtoms,
  type LaunchedAtom,
  type PipelineResult,
  type StepDetail,
} from './execution-contract.js';
import { describeTerminalFailure, formatStepOutput } from './command.js';
import { workflowCompletedBodySchema, workflowDrainEnteredBodySchema } from './events.js';
import {
  compileWorkflowPlan,
  maxStepIndex,
  resolveWorkflowJobIds,
  type CompiledPlanSlot,
  type WorkflowPlan,
} from './plan.js';
import type { WorkflowFinalizationIntent } from './finalization.js';
import { jobConversationProvider, type JobConversation } from '../jobs/conversation/entry.js';
import { hydrateJobConversation } from '../jobs/conversation/read-queries.js';
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

type RecoveredAtom = Omit<LaunchedAtom, 'requestedSeq' | 'epochKey'>;

type RecoveredWorkflowFinalization = {
  intent: WorkflowFinalizationIntent;
};

export type WorkflowRecoveryDescendant = {
  readonly jobId: string;
  readonly execution: number;
  readonly projectRoot: CanonicalWorkDir;
};

export type WorkflowRecoveryDescendantRelease = {
  jobId: string;
  execution: number;
};

export type WorkflowRecoveryAtomicClose = {
  readonly intent: WorkflowFinalizationIntent;
  readonly recording: {
    readonly execution: number;
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

type WorkflowRecoveryContext = {
  workflowId: string;
  plan: WorkflowPlan;
  childRows: readonly ProjectionJobStoredRow[];
  slotDetailsByJob: Map<string, JobProjectionDetail>;
  jobConversationsById: ReadonlyMap<string, JobConversation>;
  completion: ReturnType<typeof workflowCompletedBodySchema.parse> | null;
  drain: ReturnType<typeof workflowDrainEnteredBodySchema.parse> | null;
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
};

type RecoverySnapshot = {
  compiledSlots: CompiledPlanSlot[];
  slotDetailsByJob: Map<string, JobProjectionDetail>;
  summary: RecoverySummary;
  stepSlots: CompiledPlanSlot[];
  activeAtoms: RecoveredAtom[];
};

type WorkflowRecoveryContinuation = {
  readonly workflowId: string;
  readonly sourceRevision: string;
  readonly childIds: readonly string[];
  readonly descendants: readonly WorkflowRecoveryDescendant[];
  readonly stage: 'prepared' | 'external-outcome-unknown' | 'ready-to-close';
  readonly intendedFinalization:
    | { readonly kind: 'pending' }
    | { readonly kind: 'intent'; readonly intent: WorkflowFinalizationIntent };
  readonly completedObligations: readonly string[];
};

type HydratedWorkflowRecovery = {
  readonly envelope: RawWorkflowRecoveryEnvelope;
  readonly rootDetail: JobProjectionDetail;
  readonly projection: WorkflowProjectionRow | null;
  readonly childRows: readonly ProjectionJobStoredRow[];
  readonly slotDetailsByJob: Map<string, JobProjectionDetail>;
  readonly jobConversationsById: ReadonlyMap<string, JobConversation>;
  readonly completion: ReturnType<typeof workflowCompletedBodySchema.parse> | null;
  readonly drain: ReturnType<typeof workflowDrainEnteredBodySchema.parse> | null;
  continuation: WorkflowRecoveryContinuation;
  readonly continuationRecovered: boolean;
  continuationDurable: boolean;
  closeCompleted: boolean;
  cleanupRequired: boolean;
  deferredReason: 'unknown-external' | 'close-failed' | null;
  descendantReleases: readonly WorkflowRecoveryDescendantRelease[];
};

const WORKFLOW_RECOVERY_CONTINUATION_KIND = 'workflow-recovery.v2';
const WORKFLOW_CHILD_SETTLEMENT_MESSAGE =
  'Workflow recovery awaits recorded child terminals or a durable workflow completion; the next coordinator start rechecks them.';
const WORKFLOW_RESTART_MESSAGE = 'The coordinator restarted; the remaining workflow steps were not resumed.';
const RESUME_OBLIGATION = 'workflow-recovery.resume' as RecoveryObligationId;
const FINALIZE_OBLIGATION = 'workflow-recovery.finalize' as RecoveryObligationId;
const DESCENDANT_RELEASE_OBLIGATION = 'workflow-recovery.descendant-release' as RecoveryObligationId;

function validateAndReadCurrentSlotJobIds(
  rows: readonly ProjectionJobStoredRow[],
  workflowId: string,
  plan: WorkflowPlan,
): ReadonlyMap<string, string> {
  const slotIds = new Set<string>();
  for (const slot of plan.slots) {
    slotIds.add(slot.slotId);
  }
  const selected = new Map<string, string>();
  for (const row of rows) {
    if (row.parent_workflow_job_id !== workflowId || row.workflow_slot === null || !slotIds.has(row.workflow_slot))
      continue;
    executionOrdinalSchema.parse(row.execution);
    if (selected.has(row.workflow_slot)) {
      throw new Error(`Workflow recovery rejected duplicate jobs for slot '${row.workflow_slot}'.`);
    }
    selected.set(row.workflow_slot, row.job_id);
  }
  return selected;
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
): RecoveredAtom[] {
  const stepSlots = slots.filter((slot) => slot.stepIndex === stepIndex);
  return stepSlots.flatMap((slot, atomIndex) => {
    const detail = detailForJob(detailsByJob, slot.jobId);
    if (detail.launch === null || detail.launch.jobId === null) {
      return [];
    }
    return [
      {
        slotId: slot.slotId,
        jobId: slot.jobId,
        providerName: slot.provider,
        agent: slot.label,
        tagName: slot.tagName,
        stepIndex: slot.stepIndex,
        atomIndex,
        atomKey: slot.atomKey,
        execution: detail.launch.execution,
      },
    ];
  });
}

function validateDurableSlotRelations(
  deps: WorkflowRecoveryContext,
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
      launch.jobId !== null;
    if (!validWorkflowRelation || launch === null || launch.jobId === null || launch.provider === null) {
      throw new Error(
        `Workflow recovery rejected invalid durable relation for slot '${slot.slotId}' and job '${slot.jobId}'.`,
      );
    }

    const session = deps.jobConversationsById.get(launch.jobId);
    if (session === undefined) {
      throw new Error(
        `Workflow recovery could not find provider conversation '${launch.jobId}' for slot '${slot.slotId}'.`,
      );
    }
    if (jobConversationProvider(session) !== slot.provider) {
      throw new Error(
        `Workflow recovery rejected provider conversation '${launch.jobId}' for slot '${slot.slotId}': expected '${slot.provider}'.`,
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

function detectExistingCompletion(deps: WorkflowRecoveryContext): boolean {
  return deps.completion !== null;
}

function loadRecoverySnapshot(deps: WorkflowRecoveryContext): RecoverySnapshot {
  const compiledSlots = compileWorkflowPlan(deps.plan, { jobIds: deps.jobIds });
  const slotDetailsByJob = deps.slotDetailsByJob;
  validateDurableSlotRelations(deps, compiledSlots, slotDetailsByJob);
  const summary = summarizeCompletedSteps(compiledSlots, slotDetailsByJob);
  const stepSlots = compiledSlots.filter((slot) => slot.stepIndex === summary.activeStepIndex);
  const activeAtoms = buildLaunchedAtomsForStep(compiledSlots, summary.activeStepIndex, slotDetailsByJob);
  return { compiledSlots, slotDetailsByJob, summary, stepSlots, activeAtoms };
}

function completedFinalization(deps: WorkflowRecoveryContext, summary: RecoverySummary): RecoveredWorkflowFinalization {
  return {
    intent: completedRecoveryIntent(deps.workflowId, {
      finalOutput: summary.stepPrompt,
      stepDetails: summary.stepDetails,
    }),
  };
}

function decideWorkflowFinalization(deps: WorkflowRecoveryContext): RecoveredWorkflowFinalization | null {
  if (detectExistingCompletion(deps)) return null;

  const snapshot = loadRecoverySnapshot(deps);
  if (snapshot.summary.activeStepIndex > maxStepIndex(deps.plan)) {
    return completedFinalization(deps, snapshot.summary);
  }

  const { activeAtoms, slotDetailsByJob, summary } = snapshot;
  const terminalOutputs = new Map(
    activeAtoms.flatMap((atom) => {
      const exit = detailForJob(slotDetailsByJob, atom.jobId).exit;
      return exit === null ? [] : [[atom.atomKey, exit.content] as const];
    }),
  );
  const allLaunchedAtomsTerminal = activeAtoms.length > 0 && terminalOutputs.size === activeAtoms.length;
  if (allLaunchedAtomsTerminal) {
    const failure = firstTerminalFailure(snapshot.stepSlots, deps.drain, slotDetailsByJob);
    if (failure !== null) {
      const stepDetails = [...summary.stepDetails, ...buildStepDetailsForAtoms(activeAtoms, terminalOutputs)];
      return { intent: recoveryIntentFromFailure(deps.workflowId, failure, stepDetails) };
    }
  }

  return {
    intent: {
      outcome: 'failed',
      workflowJobId: deps.workflowId,
      lifecycleFault: {
        kind: 'recovery_failed',
        message: WORKFLOW_RESTART_MESSAGE,
      },
      stepDetails: [...summary.stepDetails, ...buildStepDetailsForAtoms(activeAtoms, terminalOutputs)],
    },
  };
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
  const descendants = z
    .array(
      z
        .object({
          jobId: z.string().min(1),
          execution: executionOrdinalSchema,
          projectRoot: z.string().min(1),
        })
        .strict(),
    )
    .parse(parsed.descendants);
  const stage = parsed.stage;
  const intendedFinalization = asRecord(parsed.intendedFinalization, 'Workflow intended finalization');
  const completedObligations = parsed.completedObligations;
  if (
    workflowId !== envelope.job.projection.job_id ||
    typeof sourceRevision !== 'string' ||
    !Array.isArray(childIds) ||
    childIds.some((value) => typeof value !== 'string') ||
    new Set(childIds).size !== childIds.length ||
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
  if (
    new Set(descendants.map((child) => child.jobId)).size !== descendants.length ||
    descendants.some((child) => !childIds.includes(child.jobId))
  ) {
    throw new TypeError(`Workflow '${workflowId}' recovery continuation has invalid child executions.`);
  }
  const canonicalDescendants = descendants.map((child) => ({
    ...child,
    projectRoot: canonicalizeWorkDir(child.projectRoot, process.cwd()),
  }));
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
    descendants: canonicalDescendants,
    stage,
    intendedFinalization: finalization,
    completedObligations: completedObligations as string[],
  };
}

function initialWorkflowContinuation(
  envelope: RawWorkflowRecoveryEnvelope,
  rootProjectRoot: CanonicalWorkDir,
): WorkflowRecoveryContinuation {
  return {
    workflowId: envelope.job.projection.job_id,
    sourceRevision: envelope.sourceRevision.value,
    childIds: envelope.children.map((child) => child.projection.job_id),
    descendants: envelope.children.map(({ projection }) => ({
      jobId: projection.job_id,
      execution: executionOrdinalSchema.parse(projection.execution),
      projectRoot: canonicalizeWorkDir(projection.project_root, rootProjectRoot),
    })),
    stage: 'prepared',
    intendedFinalization: { kind: 'pending' },
    completedObligations: [],
  };
}

function continuationDescendants(continuation: WorkflowRecoveryContinuation): readonly WorkflowRecoveryDescendant[] {
  return continuation.descendants;
}

function hydrateWorkflowRecovery(raw: RawWorkflowRecoveryEnvelope, ctx: StoreReadContext): HydratedWorkflowRecovery {
  const rootDetail = hydrateJobRecoveryProjection(raw.job, ctx);
  const rootStatus = rootDetail.status;
  if (rootStatus === null || rootStatus.jobKind !== 'workflow') {
    throw new TypeError(`Workflow recovery root '${raw.job.projection.job_id}' is not a workflow job.`);
  }
  let rootProjectRoot: CanonicalWorkDir;
  try {
    rootProjectRoot = canonicalizeWorkDir(rootStatus.projectRoot, process.cwd());
  } catch (error) {
    if (!(error instanceof WorkDirectoryError)) throw error;
    throw new Error(
      `Workflow recovery root '${raw.job.projection.job_id}' could not resolve work directory '${error.workDir}': ${error.message}`,
      { cause: error },
    );
  }
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

  const jobConversationsById = new Map<string, JobConversation>();
  for (const evidence of raw.jobConversations) {
    const entry = hydrateJobConversation(evidence);
    if (jobConversationsById.has(entry.jobId))
      throw new TypeError(`Workflow recovery repeats provider job '${entry.jobId}'.`);
    jobConversationsById.set(entry.jobId, entry);
  }

  const eventsBySeq = new Map<number, EventsRow>();
  for (const event of [...raw.job.events, ...raw.workflowEvents]) {
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
  const continuation = recoveredContinuation ?? initialWorkflowContinuation(raw, rootProjectRoot);
  return {
    envelope: raw,
    rootDetail,
    projection,
    childRows,
    slotDetailsByJob,
    jobConversationsById,
    completion,
    drain,
    continuation,
    continuationRecovered: recoveredContinuation !== null,
    continuationDurable: recoveredContinuation !== null,
    closeCompleted: false,
    cleanupRequired: false,
    deferredReason: null,
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

type RecoverAllOptions = {
  observation?: RecoveryObservation;
  db: Database;
  progressStore: StoreReadContext;
  finalizeWorkflow: (intent: WorkflowFinalizationIntent) => void;
  releaseFailedWorkflowDescendants: (workflowId: string) => readonly WorkflowRecoveryDescendantRelease[];
  signal?: AbortSignal;
  log?: (message: string) => void;
  ids: Pick<IdPort, 'uuid'>;
  time: Pick<TimePort, 'now'>;
};

const workflowRetryOptions = new WeakMap<Database, RecoverAllOptions>();

function finalizationRecording(item: HydratedWorkflowRecovery): WorkflowRecoveryAtomicClose['recording'] {
  const status = item.rootDetail.status;
  const runtime = item.rootDetail.runtime;
  if (status === null || status.execution === null || runtime?.transport !== 'workflow') {
    throw new Error(`Workflow '${item.envelope.subject.key}' has no workflow runtime start.`);
  }
  if (!Number.isFinite(Date.parse(runtime.startTime))) {
    throw new Error(`Workflow '${item.envelope.subject.key}' has an invalid runtime start timestamp.`);
  }
  return {
    execution: status.execution,
    namespace: status.backendNamespace ?? undefined,
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
  options: RecoverAllOptions,
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

function recoverWorkflowFinalization(
  item: HydratedWorkflowRecovery,
  options: RecoverAllOptions,
): { recovered: RecoveredWorkflowFinalization | null; containedFailure: unknown } {
  let recovered: RecoveredWorkflowFinalization | null;
  let containedFailure: unknown = null;
  try {
    const projection = item.projection;
    if (projection === null) {
      throw new Error('Workflow recovery could not find a workflow projection.');
    }
    const status = item.rootDetail.status;
    if (status === null) {
      throw new Error('Workflow recovery could not hydrate its root job status.');
    }
    const currentSlotJobIds = validateAndReadCurrentSlotJobIds(item.childRows, status.jobId, projection.plan);
    recovered = decideWorkflowFinalization({
      workflowId: status.jobId,
      plan: projection.plan,
      childRows: item.childRows,
      slotDetailsByJob: item.slotDetailsByJob,
      jobConversationsById: item.jobConversationsById,
      completion: item.completion,
      drain: item.drain,
      jobIds: resolveWorkflowJobIds(projection.plan, options.ids, currentSlotJobIds),
    });
  } catch (error: unknown) {
    options.signal?.throwIfAborted();
    containedFailure = error;
    recovered = {
      intent: recoveryIntentFromError(
        item.envelope.subject.key,
        new Error(`${WORKFLOW_RESTART_MESSAGE} ${errorMessage(error)}`, { cause: error }),
      ),
    };
  }

  return { recovered, containedFailure };
}

function logWorkflowRecoveryClose(
  item: HydratedWorkflowRecovery,
  intent: WorkflowFinalizationIntent,
  containedFailure: unknown,
  options: RecoverAllOptions,
): void {
  for (const released of item.descendantReleases) {
    options.log?.(`Workflow recovery child ${released.jobId} released.\n`);
  }
  if (containedFailure !== null) {
    const outcomeDescription =
      intent.outcome === 'failed' ? 'after recovery failed' : `with ${intent.outcome} outcome after recovery error`;
    options.log?.(
      `Workflow recovery finalized ${item.envelope.subject.key} ${outcomeDescription}: ${errorMessage(containedFailure)}\n`,
    );
  }
}

async function settleWorkflowRecovery(
  item: HydratedWorkflowRecovery,
  options: RecoverAllOptions,
  quarantine: RecoveryQuarantineStore,
  closedWorkflowIds: string[],
): Promise<RecoveryDisposition> {
  // Provider work requires a committed launch; a dead issuing writer cannot publish a missing child.
  if (
    item.continuationRecovered &&
    (item.continuation.stage === 'prepared' || item.continuation.stage === 'external-outcome-unknown') &&
    item.completion === null &&
    item.childRows.some((child) => child.terminal === null)
  ) {
    item.deferredReason = 'unknown-external';
    await persistWorkflowContinuation(item, quarantine);
    return {
      kind: 'deferred',
      continuation: continuationToken(item),
      detail: WORKFLOW_CHILD_SETTLEMENT_MESSAGE,
    };
  }

  const { recovered, containedFailure } =
    item.continuation.stage === 'ready-to-close' && item.continuation.intendedFinalization.kind === 'intent'
      ? { recovered: { intent: item.continuation.intendedFinalization.intent }, containedFailure: null }
      : recoverWorkflowFinalization(item, options);
  if (recovered === null) {
    if (
      quarantine.read('workflow-recovery', item.envelope.subject.key) !== null &&
      !clearWorkflowContinuation(item, quarantine)
    ) {
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
  closedWorkflowIds.push(item.envelope.subject.key);
  logWorkflowRecoveryClose(item, recovered.intent, containedFailure, options);
  return settledWorkflowResult(item, 'workflow recovery finalized and eligible descendant claims released');
}

function createWorkflowRecoveryPolicy(
  options: RecoverAllOptions,
  quarantine: RecoveryQuarantineStore,
  closedWorkflowIds: string[],
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
    settle: (item) => settleWorkflowRecovery(item, options, quarantine, closedWorkflowIds),
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
              : WORKFLOW_CHILD_SETTLEMENT_MESSAGE,
        };
      }
      return { kind: 'quarantine', detail: 'workflow recovery settlement failed before durable close' };
    },
  };
}

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

export async function recoverAll(options: RecoverAllOptions): Promise<string[]> {
  const closedWorkflowIds: string[] = [];
  const signal = options.signal ?? new AbortController().signal;
  const quarantine = new RecoveryQuarantineStore(options.db, options.time);
  workflowRetryOptions.set(options.db, options);
  await runWorkflowStartupRecovery<RawWorkflowRecoveryEnvelope, HydratedWorkflowRecovery>({
    source: workflowRecoverySource(options.db, undefined, options.observation),
    policy: {
      signal,
      quarantine,
      ...createWorkflowRecoveryPolicy(options, quarantine, closedWorkflowIds),
    },
  });
  return closedWorkflowIds;
}

export const workflowRecover = {
  recoverAll,
} as const;
