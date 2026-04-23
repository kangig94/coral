import type { InvocationContext } from '../runtime/invocation-context.js';
import type { WorkflowPlan, PlanSlot } from './plan.js';
import {
  WorkflowExecutionError,
  createWorkflowExecutionError,
  failureMetadata,
  type LaunchedAtom,
  type StepDetail,
  type WorkflowExecutionPort,
} from './command.js';
import { describeTerminalFailure } from './command.js';

export const BOOTSTRAP_TIMEOUT_MS = 2_000;

type LaunchContext = {
  slot: PlanSlot;
  atomIndex: number;
  stepPrompt: string;
  context?: string;
  workDir?: string;
  executionSvc: WorkflowExecutionPort;
  ctx: InvocationContext;
  signal?: AbortSignal;
  completedStepDetails: StepDetail[];
  workflowJobId?: string;
  onSlotJobChanged?: (slotId: string, nextJobId: string, nextSessionId: string) => void;
};

type StepLaunchResult = {
  launchedAtoms: LaunchedAtom[];
  launchError: unknown | null;
};

function isPromptSlot(slot: PlanSlot): boolean {
  return slot.label !== slot.instruction;
}

export async function readLaunchFailureMessage(
  jobId: string,
  executionSvc: WorkflowExecutionPort,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) return 'aborted during bootstrap';

  for await (const event of executionSvc.waitStream({ jobIds: [jobId], timeoutSeconds: 1 })) {
    if (event.type !== 'terminal') continue;
    return describeTerminalFailure(event.result);
  }

  return null;
}

export async function launchAtomWithRetry(context: LaunchContext): Promise<LaunchedAtom> {
  const {
    slot,
    atomIndex,
    stepPrompt,
    context: sharedContext,
    workDir,
    executionSvc,
    ctx,
    signal,
    completedStepDetails,
  } = context;
  const promptSlot = isPromptSlot(slot);
  const coralName = promptSlot ? 'workflow-literal' : slot.instruction;

  let atomPrompt: string;
  if (promptSlot) {
    if (slot.stepIndex === 0) {
      atomPrompt = sharedContext ? `${sharedContext}\n\n${slot.instruction}` : slot.instruction;
    } else {
      atomPrompt = [sharedContext, slot.instruction, stepPrompt].filter(Boolean).join('\n\n');
    }
  } else {
    atomPrompt = [sharedContext, stepPrompt].filter(Boolean).join('\n\n');
  }

  if (signal?.aborted) {
    throw createWorkflowExecutionError('Pipeline aborted (launched atoms may continue)', true, completedStepDetails);
  }

  const decision = await executionSvc.coralDispatch(
    slot.provider,
    coralName,
    {
      prompt: atomPrompt,
      jobId: slot.jobId,
      workflowSlotId: slot.slotId,
      cwd: workDir ?? ctx.projectRoot,
      parentWorkflowJobId: context.workflowJobId,
    },
    ctx,
  );

  if (decision.status === 'rejected' || !decision.job || !decision.session) {
    throw createWorkflowExecutionError(
      `Step ${slot.stepIndex}, atom '${slot.label}' launch failed: ${decision.message ?? 'unknown error'}`,
      false,
      completedStepDetails,
      { failedStep: slot.stepIndex, failedAtom: slot.label, failedSlotId: slot.slotId },
    );
  }

  const launchState = await executionSvc.awaitLaunch(decision.job, BOOTSTRAP_TIMEOUT_MS);
  if (launchState === 'error') {
    const message = await readLaunchFailureMessage(decision.job, executionSvc, signal);
    throw createWorkflowExecutionError(
      `Step ${slot.stepIndex}, atom '${slot.label}' failed: ${message ?? 'unknown error'}`,
      false,
      completedStepDetails,
      {
        failedStep: slot.stepIndex,
        failedAtom: slot.label,
        failedJobId: decision.job,
        failedSlotId: slot.slotId,
      },
    );
  }

  if (decision.job !== slot.jobId) {
    context.onSlotJobChanged?.(slot.slotId, decision.job, decision.session);
  }

  return {
    slotId: slot.slotId,
    jobId: decision.job,
    sessionId: decision.session,
    providerName: slot.provider,
    coralOp: promptSlot ? 'workflow-literal' : `coral:${slot.instruction}`,
    agent: slot.label,
    tagName: slot.tagName,
    stepIndex: slot.stepIndex,
    atomIndex,
    atomKey: slot.atomKey,
    kind: promptSlot ? 'prompt' : 'agent',
  };
}

export async function launchStepAtoms(
  plan: WorkflowPlan,
  stepIndex: number,
  stepPrompt: string,
  executionSvc: WorkflowExecutionPort,
  ctx: InvocationContext,
  options: {
    context?: string;
    workDir?: string;
    signal?: AbortSignal;
    workflowJobId?: string;
    completedStepDetails: StepDetail[];
    onPlanChange?: (nextPlan: WorkflowPlan) => void;
  },
): Promise<StepLaunchResult> {
  const launchedAtoms: LaunchedAtom[] = [];
  let launchError: unknown = null;
  let nextPlan = plan;
  const stepSlots = plan.slots.filter((slot) => slot.stepIndex === stepIndex);

  await Promise.all(
    stepSlots.map(async (slot, atomIndex) => {
      try {
        const launched = await launchAtomWithRetry({
          slot,
          atomIndex,
          stepPrompt,
          context: options.context,
          workDir: options.workDir,
          executionSvc,
          ctx,
          signal: options.signal,
          completedStepDetails: options.completedStepDetails,
          workflowJobId: options.workflowJobId,
          onSlotJobChanged: (slotId, nextJobId, nextSessionId) => {
            nextPlan = {
              workflowId: nextPlan.workflowId,
              slots: nextPlan.slots.map((candidate) =>
                candidate.slotId === slotId
                  ? { ...candidate, jobId: nextJobId, continuityRef: nextSessionId }
                  : candidate,
              ),
            };
          },
        });
        launchedAtoms.push(launched);
      } catch (error) {
        launchError ??= error;
      }
    }),
  );

  if (nextPlan !== plan) {
    options.onPlanChange?.(nextPlan);
  }

  launchedAtoms.sort((left, right) => left.atomIndex - right.atomIndex);
  return { launchedAtoms, launchError };
}

export async function handleStepLaunchFailure(
  launchError: unknown,
  launchedAtoms: LaunchedAtom[],
  options: {
    completedStepDetails: StepDetail[];
    drainLaunchedAtoms: () => Promise<StepDetail[]>;
  },
): Promise<never> {
  const drainedStepDetails = await options.drainLaunchedAtoms();
  const baseStepDetails =
    launchError instanceof WorkflowExecutionError ? launchError.stepDetails : options.completedStepDetails;
  let message = 'Unknown error';
  if (launchError instanceof Error) {
    message = launchError.message;
  } else if (typeof launchError === 'string') {
    message = launchError;
  }
  const aborted = launchError instanceof WorkflowExecutionError ? launchError.aborted : false;
  throw createWorkflowExecutionError(
    message,
    aborted,
    [...baseStepDetails, ...drainedStepDetails],
    launchError instanceof WorkflowExecutionError ? failureMetadata(launchError) : undefined,
  );
}
