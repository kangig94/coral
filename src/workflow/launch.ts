import type { InvocationContext } from '../runtime/invocation-context.js';
import type { CompiledPlanSlot } from './plan.js';
import {
  WorkflowExecutionError,
  createWorkflowExecutionError,
  failureMetadata,
  type LaunchedAtom,
  type StepDetail,
  type WaitFailure,
  type WorkflowExecutionPort,
} from './execution-contract.js';
import { describeTerminalFailure } from './command.js';

export const BOOTSTRAP_TIMEOUT_MS = 2_000;

type LaunchContext = {
  slot: CompiledPlanSlot;
  atomIndex: number;
  stepPrompt: string;
  context?: string;
  workDir?: string;
  executionSvc: WorkflowExecutionPort;
  ctx: InvocationContext;
  signal?: AbortSignal;
  completedStepDetails: StepDetail[];
  workflowJobId?: string;
};

type StepLaunchResult = {
  launchedAtoms: LaunchedAtom[];
  launchError: unknown | null;
};

type LaunchFailure = Pick<WaitFailure, 'aborted' | 'message'> &
  Partial<Pick<WaitFailure, 'causeRef' | 'terminalOutcome'>>;

function isPromptSlot(slot: CompiledPlanSlot): boolean {
  return slot.kind === 'prompt';
}

function joinPromptParts(parts: Array<string | undefined>): string {
  const joined: string[] = [];
  for (const part of parts) {
    if (part !== undefined && part.length > 0) {
      joined.push(part);
    }
  }
  return joined.join('\n\n');
}

async function readLaunchFailure(
  jobId: string,
  executionSvc: WorkflowExecutionPort,
  signal?: AbortSignal,
): Promise<LaunchFailure | null> {
  if (signal?.aborted) return { message: 'aborted during bootstrap', aborted: true };

  for await (const event of executionSvc.waitStream({ jobIds: [jobId], timeoutSeconds: 1 })) {
    if (event.type !== 'terminal') continue;
    return {
      message: describeTerminalFailure(event.result),
      aborted: event.result.outcome.kind === 'aborted',
      ...(event.result.outcome.kind === 'failed' ? { causeRef: event.result.outcome.causeRef } : {}),
      terminalOutcome: event.result.outcome,
    };
  }

  return null;
}

export async function readLaunchFailureMessage(
  jobId: string,
  executionSvc: WorkflowExecutionPort,
  signal?: AbortSignal,
): Promise<string | null> {
  return (await readLaunchFailure(jobId, executionSvc, signal))?.message ?? null;
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
      atomPrompt = joinPromptParts([sharedContext, slot.instruction, stepPrompt]);
    }
  } else {
    atomPrompt = joinPromptParts([sharedContext, stepPrompt]);
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
      retention: 'discard_provider_artifacts_on_terminal',
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
    const failure = await readLaunchFailure(decision.job, executionSvc, signal);
    throw createWorkflowExecutionError(
      `Step ${slot.stepIndex}, atom '${slot.label}' failed: ${failure?.message ?? 'unknown error'}`,
      failure?.aborted ?? false,
      completedStepDetails,
      {
        failedStep: slot.stepIndex,
        failedAtom: slot.label,
        failedJobId: decision.job,
        failedSlotId: slot.slotId,
        ...(failure?.causeRef === undefined ? {} : { causeRef: failure.causeRef }),
        ...(failure?.terminalOutcome === undefined ? {} : { terminalOutcome: failure.terminalOutcome }),
      },
    );
  }

  return {
    slotId: slot.slotId,
    jobId: decision.job,
    sessionId: decision.session,
    providerName: slot.provider,
    agent: slot.label,
    tagName: slot.tagName,
    stepIndex: slot.stepIndex,
    atomIndex,
    atomKey: slot.atomKey,
  };
}

export async function launchCompiledStepAtoms(
  stepSlots: readonly CompiledPlanSlot[],
  stepPrompt: string,
  executionSvc: WorkflowExecutionPort,
  ctx: InvocationContext,
  options: {
    context?: string;
    workDir?: string;
    signal?: AbortSignal;
    workflowJobId?: string;
    atomIndexFor?: (slot: CompiledPlanSlot, positionalIndex: number) => number;
    completedStepDetails: StepDetail[];
  },
): Promise<StepLaunchResult> {
  const launchedAtoms: LaunchedAtom[] = [];
  let launchError: unknown = null;

  await Promise.all(
    stepSlots.map(async (slot, atomIndex) => {
      try {
        const launched = await launchAtomWithRetry({
          slot,
          atomIndex: options.atomIndexFor ? options.atomIndexFor(slot, atomIndex) : atomIndex,
          stepPrompt,
          context: options.context,
          workDir: options.workDir,
          executionSvc,
          ctx,
          signal: options.signal,
          completedStepDetails: options.completedStepDetails,
          workflowJobId: options.workflowJobId,
        });
        launchedAtoms.push(launched);
      } catch (error) {
        launchError ??= error;
      }
    }),
  );

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
