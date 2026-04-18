import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { PipelineAST } from './ast.js';
import { atomDiagnosticLabel, atomTagName } from './internal/format.js';

export type PlanSlot = {
  slotId: string;
  jobId: string;
  stepIndex: number;
  tagName: string;
  atomKey: string;
  label: string;
  provider: string;
  instruction: string;
  continuityRef?: string;
};

export type WorkflowPlan = {
  workflowId: string;
  slots: PlanSlot[];
};

export const planSlotSchema = z
  .object({
    slotId: z.string(),
    jobId: z.string(),
    stepIndex: z.number().int().nonnegative(),
    tagName: z.string(),
    atomKey: z.string(),
    label: z.string(),
    provider: z.string(),
    instruction: z.string(),
    continuityRef: z.string().optional(),
  })
  .strict();

export const workflowPlanSchema = z
  .object({
    workflowId: z.string(),
    slots: z.array(planSlotSchema),
  })
  .strict();

export function buildWorkflowPlan(
  workflowId: string,
  ast: PipelineAST,
  options: {
    createJobId?: () => string;
    defaultProvider?: string;
  } = {},
): WorkflowPlan {
  const createJobId = options.createJobId ?? (() => randomUUID());
  const defaultProvider = options.defaultProvider ?? 'claude';
  const slots: PlanSlot[] = [];

  for (let stepIndex = 0; stepIndex < ast.length; stepIndex += 1) {
    const step = ast[stepIndex];
    for (let atomIndex = 0; atomIndex < step.length; atomIndex += 1) {
      const atom = step[atomIndex];
      slots.push({
        slotId: `${workflowId}:${stepIndex}:${atomIndex}`,
        jobId: createJobId(),
        stepIndex,
        tagName: atomTagName(atom),
        atomKey: `${stepIndex}:${atomIndex}`,
        label: atomDiagnosticLabel(atom, atomIndex),
        provider: atom.provider ?? defaultProvider,
        instruction: atom.kind === 'agent' ? atom.agent : atom.text,
      });
    }
  }

  return { workflowId, slots };
}

export function slotsForStep(plan: WorkflowPlan, stepIndex: number): PlanSlot[] {
  return plan.slots.filter((slot) => slot.stepIndex === stepIndex);
}

export function replacePlanSlot(plan: WorkflowPlan, slotId: string, patch: Partial<PlanSlot>): WorkflowPlan {
  return {
    workflowId: plan.workflowId,
    slots: plan.slots.map((slot) => (slot.slotId === slotId ? { ...slot, ...patch } : slot)),
  };
}
