import { sameEpoch } from '../store/epoch/identity.js';
import type { EnvPort } from '../infra/port-types.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import { assertNever, errorMessage } from '../infra/error-format.js';
import {
  createWorkflowExecutionError,
  type LaunchedAtom,
  type StepDetail,
  type WorkflowExecutionPort,
} from './execution-contract.js';
import { BOOTSTRAP_TIMEOUT_MS, readLaunchFailureMessage } from './launch.js';
import { advanceWaitRenderCursor } from '../jobs/wait/stream-event.js';
import { formatAtomProgress, type AwaitStepState, type WaitStaleRecoveryHandler } from './wait.js';

/**
 * Workflow-recovery contract: a stale atom is retried at most twice before the
 * workflow fails. Design invariant — see spec §16 #54: changing this value
 * redefines user-visible recovery semantics, so it stays a constant (NOT an
 * operator knob). Exposed under the `INVARIANT.<name>` namespace per §16 #54.
 */
const INVARIANT = {
  MAX_STALE_RECOVERY_RETRIES: 2,
} as const;

export const DEFAULT_STALE_ABORT_TIMEOUT_MS = 30_000;
export const CORAL_STALE_ABORT_TIMEOUT_MS_ENV = 'CORAL_STALE_ABORT_TIMEOUT_MS';

/**
 * Resolve how long workflow stale-recovery waits for an aborted atom to surface
 * its terminal before declaring recovery failed. Operator knob — see §16(d):
 * default 30s covers typical provider abort latency; long-running providers
 * may need more via {@link CORAL_STALE_ABORT_TIMEOUT_MS_ENV}. Clamped to a
 * minimum of 1s to keep a meaningful wait.
 */
export function resolveStaleAbortTimeoutMs(env: Pick<EnvPort, 'get'>): number {
  const raw = env.get(CORAL_STALE_ABORT_TIMEOUT_MS_ENV);
  if (raw === undefined || raw.trim() === '') return DEFAULT_STALE_ABORT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STALE_ABORT_TIMEOUT_MS;
  return Math.max(parsed, 1_000);
}

export const STALE_RESUME_PROMPT = 'Your previous execution timed out due to inactivity. Continue where you left off.';

type RecoverStaleOptions = Parameters<WaitStaleRecoveryHandler>[3];

function staleFailureMetadata(atom: LaunchedAtom, stepDetails: StepDetail[], message: string, aborted = false): never {
  throw createWorkflowExecutionError(message, aborted, stepDetails, {
    failedStep: atom.stepIndex,
    failedAtom: atom.agent,
    failedJobId: atom.jobId,
    failedSlotId: atom.slotId,
  });
}

interface StaleRecoveryContext {
  state: AwaitStepState;
  executionSvc: WorkflowExecutionPort;
  ctx: InvocationContext;
  options: RecoverStaleOptions;
}

async function observeStaleAbort(
  { state, executionSvc, options }: StaleRecoveryContext,
  atom: LaunchedAtom,
): Promise<boolean> {
  for await (const event of executionSvc.waitStream({
    jobIds: [atom.jobId],
    timeoutSeconds: options.staleAbortTimeoutMs / 1_000,
    executionSelections: [
      { jobId: atom.jobId, requestedSeq: atom.requestedSeq, epochKey: atom.epochKey, awaitingArtifact: false },
    ],
  })) {
    if (event.type !== 'terminal' || event.jobId !== atom.jobId) continue;
    const selection = event.executionSelections?.find((entry) => entry.jobId === atom.jobId);
    if (
      selection?.requestedSeq !== atom.requestedSeq ||
      !sameEpoch(selection.epochKey, atom.epochKey) ||
      selection.deliveredEndSeq !== event.seq
    )
      continue;
    if (event.result.outcome.kind !== 'aborted') return false;
    state.executionSelections = state.executionSelections.map((entry) =>
      entry.jobId === atom.jobId ? { ...selection } : entry,
    );
    state.cursor = advanceWaitRenderCursor(state.cursor, event).cursor;
    state.expectedStaleAborts.delete(atom.jobId);
    return true;
  }
  throw new Error(`Timed out waiting for execution #${atom.execution} of ${atom.jobId} to end`);
}

async function abortAndObserveStaleExecution(recovery: StaleRecoveryContext, atom: LaunchedAtom): Promise<boolean> {
  const { state, executionSvc, options } = recovery;
  options.onProgress(formatAtomProgress(atom, 'stale, aborting'));
  const abortResult = executionSvc.abort([atom.jobId]);
  const abortTransitionedLiveJob = abortResult.aborted.includes(atom.jobId);
  if (!abortTransitionedLiveJob) return false;
  state.expectedStaleAborts.set(atom.jobId, {
    execution: atom.execution,
    requestedSeq: atom.requestedSeq,
    epochKey: atom.epochKey,
  });

  try {
    return await observeStaleAbort(recovery, atom);
  } catch (error: unknown) {
    staleFailureMetadata(
      atom,
      options.buildPartialStepDetails(),
      `Step ${atom.stepIndex}, atom '${atom.agent}' stale recovery abort failed: ${errorMessage(error)}`,
    );
  }
}

async function resumeStaleExecution(
  { executionSvc, ctx, options }: StaleRecoveryContext,
  atom: LaunchedAtom,
  workflowJobId: string,
) {
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
      jobId: atom.jobId,
      prompt: STALE_RESUME_PROMPT,
      cwd: options.workDir ?? ctx.projectRoot,
      parentWorkflowJobId: workflowJobId,
      workflowSlotId: atom.slotId,
      owner: { kind: 'workflow', id: workflowJobId },
    },
    ctx,
  );

  switch (resumed.status) {
    case 'refused':
      return staleFailureMetadata(
        atom,
        options.buildPartialStepDetails(),
        `Step ${atom.stepIndex}, atom '${atom.agent}' resume failed: ${resumed.message}`,
      );
    case 'undetermined':
      return staleFailureMetadata(
        atom,
        options.buildPartialStepDetails(),
        `Step ${atom.stepIndex}, atom '${atom.agent}' resume check established nothing: ${resumed.message}`,
      );
    case 'running':
    case 'queued':
      break;
    default:
      assertNever(resumed);
  }

  return resumed;
}

async function resumeAndReplaceStaleExecution(
  recovery: StaleRecoveryContext,
  atom: LaunchedAtom,
  workflowJobId: string,
): Promise<void> {
  const { state, executionSvc, options } = recovery;
  const resumed = await resumeStaleExecution(recovery, atom, workflowJobId);
  state.pending.set(atom.jobId, {
    ...atom,
    execution: atom.execution + 1,
    requestedSeq: resumed.requestedSeq,
    epochKey: resumed.epochKey,
  });
  state.executionSelections = state.executionSelections.map((entry) =>
    entry.jobId === atom.jobId
      ? { jobId: atom.jobId, requestedSeq: resumed.requestedSeq, epochKey: resumed.epochKey, awaitingArtifact: false }
      : entry,
  );
  const launchState = await executionSvc.awaitLaunch(resumed.jobId, BOOTSTRAP_TIMEOUT_MS);
  if (launchState === 'error') {
    const message = await readLaunchFailureMessage(resumed.jobId, executionSvc, options.signal, resumed);
    staleFailureMetadata(
      atom,
      options.buildPartialStepDetails(),
      `Step ${atom.stepIndex}, atom '${atom.agent}' resume failed: ${message ?? 'unknown error'}`,
    );
  }
}

export async function recoverStaleAtom(
  state: AwaitStepState,
  executionSvc: WorkflowExecutionPort,
  ctx: InvocationContext,
  options: RecoverStaleOptions,
): Promise<boolean> {
  for (const atom of state.pending.values()) {
    if ((state.observedIdleMs.get(atom.atomKey) ?? 0) < options.staleTimeoutMs) continue;

    const retries = state.staleRetries.get(atom.atomKey) ?? 0;
    if (retries >= INVARIANT.MAX_STALE_RECOVERY_RETRIES) {
      staleFailureMetadata(
        atom,
        options.buildPartialStepDetails(),
        `Step ${atom.stepIndex}, atom '${atom.agent}' stale after ${retries} recovery attempts`,
      );
    }

    const workflowJobId = options.workflowJobId;
    if (workflowJobId === undefined) {
      staleFailureMetadata(
        atom,
        options.buildPartialStepDetails(),
        `Step ${atom.stepIndex}, atom '${atom.agent}' stale recovery has no workflow owner`,
      );
    }

    const recovery = { state, executionSvc, ctx, options };
    if (!(await abortAndObserveStaleExecution(recovery, atom))) return false;
    await resumeAndReplaceStaleExecution(recovery, atom, workflowJobId);

    state.staleRetries.set(atom.atomKey, retries + 1);

    const resumedAt = options.time.now();
    for (const sibling of state.pending.values()) {
      state.lastActivityAt.set(sibling.atomKey, resumedAt);
      state.observedIdleMs.set(sibling.atomKey, 0);
    }

    options.onProgress(formatAtomProgress(atom, 'resumed'));
    return true;
  }

  return false;
}
