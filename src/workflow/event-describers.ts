// Per-event describers for the `workflow/*` stream. Owned by the workflow
// domain and composed into the default `EventDescriberMap` by
// `read-model/event-describers.ts`.

import type { EventDescriber, EventDescriberMap } from '../causality/render.js';
import { isRecord } from '../infra/json.js';

const planDeclared: EventDescriber = () => 'Workflow plan declared.';
const planRevised: EventDescriber = () => 'Workflow plan revised.';
const drainEntered: EventDescriber = () => 'Workflow entered failure drain.';

const completed: EventDescriber = (event) => {
  if (isRecord(event.body) && typeof event.body.outcome === 'string') {
    return `Workflow ${event.body.outcome}.`;
  }
  return 'Workflow completed.';
};

export const workflowEventDescribers: EventDescriberMap = new Map<string, EventDescriber>([
  ['workflow:workflow.plan.declared', planDeclared],
  ['workflow:workflow.plan.revised', planRevised],
  ['workflow:workflow.drain.entered', drainEntered],
  ['workflow:workflow.completed', completed],
]);
