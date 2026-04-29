import type { EnvPort } from '../runtime/ports.js';
import type { InvocationContext } from '../runtime/invocation-context.js';
import { errorMessage } from '../infra/error-format.js';
import {
  createWorkflowExecutionError,
  type LaunchedAtom,
  type StepDetail,
  type WorkflowExecutionPort,
} from './command.js';
import { BOOTSTRAP_TIMEOUT_MS, readLaunchFailureMessage } from './launch.js';
import { formatAtomProgress, type AwaitStepState, type WaitStaleRecoveryHandler } from './wait.js';

/**
 * Workflow-recovery contract: a stale atom is retried at most twice before the
 * workflow fails. Design invariant — see §16(d) and §16 cross-reference: changing
 * this value redefines user-visible recovery semantics, so it stays a constant
 * (NOT an operator knob).
 */
const MAX_STALE_RECOVERY_RETRIES = 2;

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

const STALE_RESUME_PROMPT = 'Your previous execution timed out due to inactivity. Continue where you left off.';

type RecoverStaleOptions = Parameters<WaitStaleRecoveryHandler>[3];

function staleFailureMetadata(
  atom: LaunchedAtom,
  stepDetails: StepDetail[],
  message: string,
  aborted = false,
): never {
  throw createWorkflowExecutionError(message, aborted, stepDetails, {
    failedStep: atom.stepIndex,
    failedAtom: atom.agent,
    failedJobId: atom.jobId,
    failedSlotId: atom.slotId,
  });
}

export async function recoverStaleAtom(
  state: AwaitStepState,
  executionSvc: WorkflowExecutionPort,
  ctx: InvocationContext,
  options: RecoverStaleOptions,
): Promise<boolean> {
  const now = options.time.now();

  for (const atom of state.pending.values()) {
    const lastActive = state.lastActivityAt.get(atom.atomKey) ?? now;
    if (now - lastActive < options.staleTimeoutMs) continue;

    const retries = state.staleRetries.get(atom.atomKey) ?? 0;
    if (retries >= MAX_STALE_RECOVERY_RETRIES) {
      staleFailureMetadata(
        atom,
        options.buildPartialStepDetails(),
        `Step ${atom.stepIndex}, atom '${atom.agent}' stale after ${retries} recovery attempts`,
      );
    }

    state.expectedStaleAborts.add(atom.jobId);
    options.onProgress(formatAtomProgress(atom, 'stale, aborting'));
    executionSvc.abort([atom.jobId]);

    try {
      await executionSvc.waitForJobTerminal(atom.jobId, options.staleAbortTimeoutMs);
    } catch (error: unknown) {
      staleFailureMetadata(
        atom,
        options.buildPartialStepDetails(),
        `Step ${atom.stepIndex}, atom '${atom.agent}' stale recovery abort failed: ${errorMessage(error)}`,
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
        ...(options.workflowJobId === undefined
          ? {}
          : {
              parentWorkflowJobId: options.workflowJobId,
              workflowSlotId: atom.slotId,
            }),
      },
      ctx,
    );

    if (resumed.status === 'rejected' || !resumed.job || !resumed.session) {
      staleFailureMetadata(
        atom,
        options.buildPartialStepDetails(),
        `Step ${atom.stepIndex}, atom '${atom.agent}' resume failed: ${resumed.message ?? 'unknown error'}`,
      );
    }

    const launchState = await executionSvc.awaitLaunch(resumed.job, BOOTSTRAP_TIMEOUT_MS);
    if (launchState === 'error') {
      const message = await readLaunchFailureMessage(resumed.job, executionSvc, options.signal);
      staleFailureMetadata(
        atom,
        options.buildPartialStepDetails(),
        `Step ${atom.stepIndex}, atom '${atom.agent}' resume failed: ${message ?? 'unknown error'}`,
      );
    }

    state.pending.delete(atom.jobId);
    state.pending.set(resumed.job, {
      ...atom,
      jobId: resumed.job,
      sessionId: resumed.session,
    });
    state.staleRetries.set(atom.atomKey, retries + 1);

    const resumedAt = options.time.now();
    for (const sibling of state.pending.values()) {
      state.lastActivityAt.set(sibling.atomKey, resumedAt);
    }

    options.onProgress(formatAtomProgress(atom, 'resumed'));
    return true;
  }

  return false;
}
