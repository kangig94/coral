import { discussRegistry } from '../discuss/event-registry.js';
import { jobsRegistry } from '../jobs/events.js';
import { sessionsRegistry } from '../sessions/events.js';
import { workflowRegistry } from '../workflow/events.js';
import type { StoreReadContext } from '../store/body-codec.js';
import { composeReducers } from '../store/reducers.js';
import { createDefaultUpcasterRegistry } from '../store/upcasters.js';

const defaultReducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);
let defaultReadCtx: StoreReadContext | null = null;

export function createDefaultStoreReadContext(): StoreReadContext {
  defaultReadCtx ??= {
    schemas: defaultReducers.schemas,
    upcasters: createDefaultUpcasterRegistry(),
  };
  return defaultReadCtx;
}
