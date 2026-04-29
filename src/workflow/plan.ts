import { z } from 'zod';

import { truncate } from '../infra/text.js';
import type { PipelineAST } from './ast.js';

export type PlanSlot = {
  slotId: string;
  dependencies: string[];
  provider: string;
  instruction: string;
  agent?: string;
};

export type WorkflowPlan = {
  slots: PlanSlot[];
};

export type WorkflowSlotIdParts = {
  workflowId: string;
  stepIndex: number;
  atomIndex: number;
};

export type CompiledPlanSlot = PlanSlot & {
  jobId: string;
  stepIndex: number;
  tagName: string;
  atomKey: string;
  label: string;
  kind: 'agent' | 'prompt';
};

export const planSlotSchema = z
  .object({
    slotId: z.string(),
    dependencies: z.array(z.string()).default([]),
    provider: z.string(),
    instruction: z.string(),
    agent: z.string().optional(),
  })
  .strict();

export const workflowPlanSchema = z
  .object({
    slots: z.array(planSlotSchema),
  })
  .strict();

function parseNonnegativeIntegerComponent(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function parseWorkflowSlotId(slotId: string): WorkflowSlotIdParts | null {
  const atomSeparator = slotId.lastIndexOf(':');
  if (atomSeparator <= 0 || atomSeparator === slotId.length - 1) {
    return null;
  }

  const stepSeparator = slotId.lastIndexOf(':', atomSeparator - 1);
  if (stepSeparator <= 0 || stepSeparator === atomSeparator - 1) {
    return null;
  }

  const workflowId = slotId.slice(0, stepSeparator);
  const stepIndex = parseNonnegativeIntegerComponent(slotId.slice(stepSeparator + 1, atomSeparator));
  const atomIndex = parseNonnegativeIntegerComponent(slotId.slice(atomSeparator + 1));
  if (workflowId.length === 0 || stepIndex === null || atomIndex === null) {
    return null;
  }

  return { workflowId, stepIndex, atomIndex };
}

export function buildWorkflowPlan(
  workflowId: string,
  ast: PipelineAST,
  options: {
    defaultProvider?: string;
  } = {},
): WorkflowPlan {
  const defaultProvider = options.defaultProvider ?? 'claude';
  const slots: PlanSlot[] = [];
  let dependencies: string[] = [];

  for (let stepIndex = 0; stepIndex < ast.length; stepIndex += 1) {
    const step = ast[stepIndex];
    const stepSlotIds: string[] = [];

    for (let atomIndex = 0; atomIndex < step.length; atomIndex += 1) {
      const atom = step[atomIndex];
      const slotId = `${workflowId}:${stepIndex}:${atomIndex}`;
      stepSlotIds.push(slotId);
      slots.push({
        slotId,
        dependencies,
        provider: atom.provider ?? defaultProvider,
        instruction: atom.kind === 'agent' ? atom.agent : atom.text,
        ...(atom.kind === 'agent' ? { agent: atom.agent } : {}),
      });
    }

    dependencies = stepSlotIds;
  }

  return { slots };
}

export function defaultJobIdForSlot(slot: PlanSlot): string {
  return slot.slotId;
}

export function compileWorkflowPlan(
  plan: WorkflowPlan,
  options: {
    jobIds?: ReadonlyMap<string, string>;
  } = {},
): CompiledPlanSlot[] {
  const stepIndexes = computeStepIndexes(plan);
  const atomIndexesByStep = new Map<number, number>();

  return plan.slots.map((slot) => {
    const stepIndex = stepIndexes.get(slot.slotId) ?? 0;
    const atomIndex = atomIndexesByStep.get(stepIndex) ?? 0;
    atomIndexesByStep.set(stepIndex, atomIndex + 1);
    const agent = slot.agent;
    const kind: CompiledPlanSlot['kind'] = agent === undefined ? 'prompt' : 'agent';
    const tagName = agent ?? 'step-result';
    const label = agent ?? `prompt#${atomIndex}(${truncate(slot.instruction, 20)})`;

    return {
      ...slot,
      jobId: options.jobIds?.get(slot.slotId) ?? defaultJobIdForSlot(slot),
      stepIndex,
      tagName,
      atomKey: `${stepIndex}:${atomIndex}`,
      label,
      kind,
    };
  });
}

export function slotsForStep(
  plan: WorkflowPlan,
  stepIndex: number,
  options: {
    jobIds?: ReadonlyMap<string, string>;
  } = {},
): CompiledPlanSlot[] {
  return compileWorkflowPlan(plan, options).filter((slot) => slot.stepIndex === stepIndex);
}

export function maxStepIndex(plan: WorkflowPlan): number {
  const stepIndexes = computeStepIndexes(plan);
  let max = -1;
  for (const value of stepIndexes.values()) {
    max = Math.max(max, value);
  }
  return max;
}

function computeStepIndexes(plan: WorkflowPlan): Map<string, number> {
  const slotsById = new Map(plan.slots.map((slot) => [slot.slotId, slot]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const depth = (slotId: string): number => {
    const cached = memo.get(slotId);
    if (cached !== undefined) {
      return cached;
    }

    const slot = slotsById.get(slotId);
    if (!slot) {
      throw new Error(`Workflow plan dependency references unknown slot '${slotId}'.`);
    }
    if (visiting.has(slotId)) {
      throw new Error(`Workflow plan contains a dependency cycle at slot '${slotId}'.`);
    }

    visiting.add(slotId);
    const stepIndex =
      slot.dependencies.length === 0
        ? 0
        : Math.max(...slot.dependencies.map((dependency) => depth(dependency))) + 1;
    visiting.delete(slotId);
    memo.set(slotId, stepIndex);
    return stepIndex;
  };

  for (const slot of plan.slots) {
    depth(slot.slotId);
  }

  return memo;
}
