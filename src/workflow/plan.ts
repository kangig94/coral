import { z } from 'zod';

import { truncate } from '../infra/text.js';
import type { IdPort } from '../runtime/ports.js';
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

export type CompiledPlanSlot = PlanSlot & {
  jobId: string;
  stepIndex: number;
  tagName: string;
  atomKey: string;
  label: string;
  kind: 'agent' | 'prompt';
};

export function workflowSlotLabel(slot: PlanSlot, atomIndex: number): string {
  return slot.agent ?? `prompt#${atomIndex}(${truncate(slot.instruction, 20)})`;
}

const planSlotSchema = z
  .object({
    slotId: z.string(),
    dependencies: z.array(z.string()),
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

export function resolveWorkflowJobIds(
  plan: WorkflowPlan,
  ids: Pick<IdPort, 'uuid'>,
  existing: ReadonlyMap<string, string> = new Map(),
): ReadonlyMap<string, string> {
  const jobIds = new Map(existing);
  for (const slot of plan.slots) {
    if (!jobIds.has(slot.slotId)) jobIds.set(slot.slotId, ids.uuid());
  }
  return jobIds;
}

export function compileWorkflowPlan(
  plan: WorkflowPlan,
  options: {
    jobIds: ReadonlyMap<string, string>;
  },
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
    const label = workflowSlotLabel(slot, atomIndex);
    const jobId = options.jobIds.get(slot.slotId);
    if (jobId === undefined) {
      throw new Error(`Workflow plan slot '${slot.slotId}' has no resolved job id.`);
    }

    return {
      ...slot,
      jobId,
      stepIndex,
      tagName,
      atomKey: `${stepIndex}:${atomIndex}`,
      label,
      kind,
    };
  });
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
  const slotsById = new Map<string, WorkflowPlan['slots'][number]>();
  for (const slot of plan.slots) {
    slotsById.set(slot.slotId, slot);
  }
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
    let stepIndex = 0;
    for (const dependency of slot.dependencies) {
      stepIndex = Math.max(stepIndex, depth(dependency) + 1);
    }
    visiting.delete(slotId);
    memo.set(slotId, stepIndex);
    return stepIndex;
  };

  for (const slot of plan.slots) {
    depth(slot.slotId);
  }

  return memo;
}
