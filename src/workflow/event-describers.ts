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
const completed = typedDescriber(workflowCompletedBodySchema, (body) => `Workflow ${body.outcome}.`);
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
