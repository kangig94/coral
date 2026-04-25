import { randomUUID } from 'node:crypto';

import type { InvocationContext } from '../runtime/invocation-context.js';
import { errorMessage } from '../infra/error-format.js';
import type { PipelineAST } from './ast.js';
import {
  formatStepOutput,
  WorkflowExecutionError,
  buildStepDetailsForAtoms,
  createWorkflowExecutionError,
  type LaunchedAtom,
  type PipelineResult,
  type StepDetail,
  type WorkflowExecutionPort,
} from './command.js';
import { handleStepLaunchFailure, launchStepAtoms } from './launch.js';
import { workflowCompletedEvent, workflowDrainEnteredEvent, workflowPlanDeclaredEvent, workflowPlanRevisedEvent } from './events.js';
import { DEFAULT_STALE_TIMEOUT_MS, DEFAULT_STALE_CHECK_INTERVAL_MS } from './execution-constants.js';
import { buildWorkflowPlan, type WorkflowPlan } from './plan.js';
import type { WorkflowJournal } from './projections.js';
import { recoverStaleAtom } from './stale-recovery.js';
import { waitForAtoms } from './wait.js';

type ExecutePlannedStepsOptions = {
  context?: string;
  workDir?: string;
  signal?: AbortSignal;
  onProgress: (message: string) => void;
  staleTimeoutMs: number;
  staleCheckIntervalMs: number;
  workflowJobId?: string;
  journal?: WorkflowJournal;
  startStepIndex?: number;
  completedStepDetails?: StepDetail[];
};

type FinalizedStep = {
  stepDetails: StepDetail[];
  stepPrompt: string;
};

function applyPlanRevision(
  plan: WorkflowPlan,
  nextAtoms: readonly LaunchedAtom[],
): WorkflowPlan {
  const replacements = new Map(nextAtoms.map((atom) => [atom.slotId, atom]));
  if (replacements.size === 0) return plan;

  return {
    workflowId: plan.workflowId,
    slots: plan.slots.map((slot) => {
      const atom = replacements.get(slot.slotId);
      if (!atom) return slot;
      return {
        ...slot,
        jobId: atom.jobId,
        continuityRef: atom.sessionId,
      };
    }),
  };
}

function maybeAppendPlanRevised(
  workflowId: string | undefined,
  previousPlan: WorkflowPlan,
  nextPlan: WorkflowPlan,
  journal?: WorkflowJournal,
): void {
  if (!workflowId || !journal) return;
  if (JSON.stringify(previousPlan) === JSON.stringify(nextPlan)) return;
  journal.append([workflowPlanRevisedEvent(workflowId, nextPlan)]);
}

function requireStepResult(stepIndex: number, atom: LaunchedAtom, results: Map<string, string>): string {
  const output = results.get(atom.atomKey);
  if (output !== undefined) return output;
  throw new Error(`Step ${stepIndex}, atom '${atom.agent}' completed without a result`);
}

export function buildPartialStepDetails(
  atoms: LaunchedAtom[],
  completedStepDetails: StepDetail[],
  results: Map<string, string>,
): StepDetail[] {
  return [...completedStepDetails, ...buildStepDetailsForAtoms(atoms, results)];
}

async function drainLaunchedAtoms(
  launchedAtoms: LaunchedAtom[],
  executionSvc: WorkflowExecutionPort,
  ctx: InvocationContext,
  options: {
    signal?: AbortSignal;
    staleTimeoutMs: number;
    staleCheckIntervalMs: number;
    workDir?: string;
    onProgress: (message: string) => void;
  },
): Promise<StepDetail[]> {
  if (launchedAtoms.length === 0) return [];

  executionSvc.abort(launchedAtoms.map((atom) => atom.jobId));

  try {
    const results = await waitForAtoms(launchedAtoms, executionSvc, ctx, {
      signal: options.signal,
      staleTimeoutMs: options.staleTimeoutMs,
      staleCheckIntervalMs: options.staleCheckIntervalMs,
      workDir: options.workDir,
      onProgress: options.onProgress,
      completedStepDetails: [],
      recoverStaleAtom,
    });
    return buildStepDetailsForAtoms(launchedAtoms, results);
  } catch (error) {
    if (error instanceof WorkflowExecutionError) {
      return error.stepDetails;
    }
    throw error;
  }
}

async function awaitLaunchedStepResults(
  plan: WorkflowPlan,
  launchedAtoms: LaunchedAtom[],
  stepIndex: number,
  executionSvc: WorkflowExecutionPort,
  ctx: InvocationContext,
  options: {
    signal?: AbortSignal;
    staleTimeoutMs: number;
    staleCheckIntervalMs: number;
    workDir?: string;
    onProgress: (message: string) => void;
    completedStepDetails: StepDetail[];
    workflowJobId?: string;
    journal?: WorkflowJournal;
    onPlanChange: (nextPlan: WorkflowPlan) => void;
  },
): Promise<Map<string, string>> {
  let workingPlan = plan;
  try {
    return await waitForAtoms(launchedAtoms, executionSvc, ctx, {
      signal: options.signal,
      staleTimeoutMs: options.staleTimeoutMs,
      staleCheckIntervalMs: options.staleCheckIntervalMs,
      workDir: options.workDir,
      onProgress: options.onProgress,
      completedStepDetails: options.completedStepDetails,
      recoverStaleAtom,
      onFailureDrain: (_state, failure) => {
        if (!options.workflowJobId || !options.journal || !failure.failedSlotId) return;
        options.journal.append([
          workflowDrainEnteredEvent(options.workflowJobId, {
            firstFailureSlotId: failure.failedSlotId,
            drainDeadline: Date.now() + 15_000,
          }),
        ]);
      },
      onStaleSwap: (state) => {
        const previousPlan = workingPlan;
        const nextPlan = applyPlanRevision(workingPlan, state.atoms);
        if (nextPlan !== previousPlan) {
          options.onPlanChange(nextPlan);
          workingPlan = nextPlan;
          maybeAppendPlanRevised(options.workflowJobId, previousPlan, nextPlan, options.journal);
        }
      },
    });
  } catch (error) {
    if (error instanceof WorkflowExecutionError) {
      throw error;
    }

    throw createWorkflowExecutionError(errorMessage(error), Boolean(options.signal?.aborted), [...options.completedStepDetails]);
  }
}

function finalizeStep(
  stepIndex: number,
  launchedAtoms: LaunchedAtom[],
  stepResults: Map<string, string>,
): FinalizedStep {
  return {
    stepDetails: buildStepDetailsForAtoms(launchedAtoms, stepResults),
    stepPrompt: formatStepOutput(
      launchedAtoms.map((atom) => ({
        tagName: atom.tagName,
        output: requireStepResult(stepIndex, atom, stepResults),
      })),
    ),
  };
}

export async function executePlannedSteps(
  plan: WorkflowPlan,
  initialPrompt: string,
  executionSvc: WorkflowExecutionPort,
  ctx: InvocationContext,
  options: ExecutePlannedStepsOptions,
): Promise<PipelineResult & { plan: WorkflowPlan }> {
  const stepDetails: StepDetail[] = [...(options.completedStepDetails ?? [])];
  let stepPrompt = initialPrompt;
  let workingPlan = plan;
  const allLaunchedAtoms: LaunchedAtom[] = [];
  const maxStepIndex = workingPlan.slots.reduce((max, slot) => Math.max(max, slot.stepIndex), -1);
  const startStepIndex = options.startStepIndex ?? 0;

  try {
    for (let stepIndex = startStepIndex; stepIndex <= maxStepIndex; stepIndex += 1) {
      options.onProgress(`step ${stepIndex} started`);

      const { launchedAtoms, launchError } = await launchStepAtoms(
        workingPlan,
        stepIndex,
        stepPrompt,
        executionSvc,
        ctx,
        {
          context: options.context,
          workDir: options.workDir,
          signal: options.signal,
          workflowJobId: options.workflowJobId,
          completedStepDetails: stepDetails,
          onPlanChange: (nextPlan) => {
            maybeAppendPlanRevised(options.workflowJobId, workingPlan, nextPlan, options.journal);
            workingPlan = nextPlan;
          },
        },
      );
      allLaunchedAtoms.push(...launchedAtoms);

      if (launchError !== null) {
        await handleStepLaunchFailure(launchError, launchedAtoms, {
          completedStepDetails: stepDetails,
          drainLaunchedAtoms: () =>
            drainLaunchedAtoms(launchedAtoms, executionSvc, ctx, {
              signal: options.signal,
              staleTimeoutMs: options.staleTimeoutMs,
              staleCheckIntervalMs: options.staleCheckIntervalMs,
              workDir: options.workDir,
              onProgress: options.onProgress,
            }),
        });
      }

      const stepResults = await awaitLaunchedStepResults(workingPlan, launchedAtoms, stepIndex, executionSvc, ctx, {
        signal: options.signal,
        staleTimeoutMs: options.staleTimeoutMs,
        staleCheckIntervalMs: options.staleCheckIntervalMs,
        workDir: options.workDir,
        onProgress: options.onProgress,
        completedStepDetails: stepDetails,
        workflowJobId: options.workflowJobId,
        journal: options.journal,
        onPlanChange: (nextPlan) => {
          workingPlan = nextPlan;
        },
      });
      const completedStep = finalizeStep(stepIndex, launchedAtoms, stepResults);
      stepDetails.push(...completedStep.stepDetails);
      stepPrompt = completedStep.stepPrompt;
      options.onProgress(`step ${stepIndex} completed`);
    }

    return {
      finalOutput: stepPrompt,
      stepDetails,
      plan: workingPlan,
    };
  } finally {
    executionSvc.cleanupWorkflowSessions(
      [...new Map(allLaunchedAtoms.map((atom) => [`${atom.providerName}:${atom.sessionId}`, { providerName: atom.providerName, sessionId: atom.sessionId }])).values()],
    );
  }
}

export async function executePipeline(
  ast: PipelineAST,
  initialPrompt: string,
  defaultProviderName: string,
  executionSvc: WorkflowExecutionPort,
  ctx: InvocationContext,
  options: {
    context?: string;
    workDir?: string;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
    staleTimeoutMs?: number;
    staleCheckIntervalMs?: number;
    workflowJobId?: string;
    journal?: WorkflowJournal;
    createJobId?: () => string;
  } = {},
): Promise<PipelineResult> {
  const onProgress = options.onProgress ?? (() => {});
  const staleTimeoutMs = options.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS;
  const staleCheckIntervalMs = options.staleCheckIntervalMs ?? DEFAULT_STALE_CHECK_INTERVAL_MS;
  const workflowId = options.workflowJobId ?? randomUUID();
  const plan = buildWorkflowPlan(workflowId, ast, {
    createJobId: options.createJobId,
    defaultProvider: defaultProviderName,
  });

  if (options.workflowJobId && options.journal) {
    options.journal.append([workflowPlanDeclaredEvent(options.workflowJobId, plan)]);
  }

  try {
    const result = await executePlannedSteps(plan, initialPrompt, executionSvc, ctx, {
      context: options.context,
      workDir: options.workDir,
      signal: options.signal,
      onProgress,
      staleTimeoutMs,
      staleCheckIntervalMs,
      workflowJobId: options.workflowJobId,
      journal: options.journal,
    });
    if (options.workflowJobId && options.journal) {
      options.journal.append([workflowCompletedEvent(options.workflowJobId, { outcome: 'completed' })]);
    }
    return {
      finalOutput: result.finalOutput,
      stepDetails: result.stepDetails,
    };
  } catch (error) {
    if (options.workflowJobId && options.journal) {
      if (error instanceof WorkflowExecutionError) {
        options.journal.append([
          workflowCompletedEvent(options.workflowJobId, {
            outcome: error.aborted ? 'aborted' : 'failed',
            ...(error.aborted || !error.causeRef ? {} : { causeRef: error.causeRef }),
          }),
        ]);
      } else {
        options.journal.append([workflowCompletedEvent(options.workflowJobId, { outcome: 'failed' })]);
      }
    }
    throw error;
  }
}
