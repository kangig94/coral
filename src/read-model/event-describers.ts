// Composes the default `EventDescriberMap` consumed by causality's cause-ref
// renderer. Each domain owns its own describers; this module is the single
// composition site that joins them. Lives in `read-model/` because composing
// cross-domain read vocabulary is the read-model layer's purpose, mirroring
// how `CoralStore` joins per-domain queries.

import type { EventDescriberMap } from '../causality/render.js';
import { discussEventDescribers } from '../discuss/event-describers.js';
import { jobsEventDescribers } from '../jobs/event-describers.js';
import { sessionsEventDescribers } from '../sessions/event-describers.js';
import { workflowEventDescribers } from '../workflow/event-describers.js';

export const defaultEventDescribers: EventDescriberMap = new Map([
  ...jobsEventDescribers,
  ...sessionsEventDescribers,
  ...discussEventDescribers,
  ...workflowEventDescribers,
]);
