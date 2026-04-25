// Per-event describers for the `workflow/*` stream. Owned by the workflow
// domain and composed into the default `EventDescriberMap` by
// `read-model/event-describers.ts`.

import { typedDescriber, type EventDescriber, type EventDescriberMap } from '../causality/render.js';
import {
  workflowCompletedBodySchema,
  workflowDrainEnteredBodySchema,
} from './events.js';
import { workflowPlanSchema } from './plan.js';

const planDeclared = typedDescriber(workflowPlanSchema, () => 'Workflow plan declared.');
const planRevised = typedDescriber(workflowPlanSchema, () => 'Workflow plan revised.');
const drainEntered = typedDescriber(workflowDrainEnteredBodySchema, () => 'Workflow entered failure drain.');
const completed = typedDescriber(workflowCompletedBodySchema, (body) => `Workflow ${body.outcome}.`);

export const workflowEventDescribers: EventDescriberMap = new Map<string, EventDescriber>([
  ['workflow:workflow.plan.declared', planDeclared],
  ['workflow:workflow.plan.revised', planRevised],
  ['workflow:workflow.drain.entered', drainEntered],
  ['workflow:workflow.completed', completed],
]);
