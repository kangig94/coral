// Per-event describers for the `workflow/*` stream. Owned by the workflow
// domain and composed into the default `EventDescriberMap` by
// `read-model/event-describers.ts`.

import { typedDescriber, type EventDescriber, type EventDescriberMap } from '../causality/render.js';
import {
  workflowCompletedBodySchema,
  workflowDrainEnteredBodySchema,
  workflowLifecycleFaultBodySchema,
} from './events.js';
import { workflowPlanSchema } from './plan.js';

const planDeclared = typedDescriber(workflowPlanSchema, () => 'Workflow plan declared.');
const drainEntered = typedDescriber(workflowDrainEnteredBodySchema, () => 'Workflow entered failure drain.');
const completed = typedDescriber(workflowCompletedBodySchema, (body) => {
  const base = `Workflow ${body.outcome}.`;
  if (body.outcome !== 'failed' || body.failureLocation === undefined) return base;
  const { stepIndex, atomLabel, slotId, jobId } = body.failureLocation;
  const parts: string[] = [];
  if (stepIndex !== undefined) parts.push(`step ${stepIndex}`);
  if (atomLabel !== undefined) parts.push(`atom '${atomLabel}'`);
  if (slotId !== undefined) parts.push(`slot ${slotId}`);
  if (jobId !== undefined) parts.push(`job ${jobId}`);
  return parts.length === 0 ? base : `${base} Failure at ${parts.join(', ')}.`;
});
const lifecycleFault = typedDescriber(workflowLifecycleFaultBodySchema, (body) => {
  const base = `Workflow lifecycle fault (${body.kind}): ${body.message}.`;
  // wrapper_crashed and recovery_failed carry a stack trace; surface it on
  // the describer's output so chain-walk fault rendering matches the jobs-
  // domain convention of inlining stack on fault paths.
  return 'stack' in body && typeof body.stack === 'string' ? `${base}\n${body.stack}` : base;
});

export const workflowEventDescribers: EventDescriberMap = new Map<string, EventDescriber>([
  ['workflow:workflow.plan.declared', planDeclared],
  ['workflow:workflow.drain.entered', drainEntered],
  ['workflow:workflow.completed', completed],
  ['workflow:workflow.lifecycle_fault', lifecycleFault],
]);
