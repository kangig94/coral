import { discussRegistry } from '../discuss/store-registry.js';
import { jobsRegistry } from '../jobs/events.js';
import { sessionsRegistry } from '../sessions/events.js';
import { workflowRegistry } from '../workflow/events.js';
import type { StoreReadContext } from './body-codec.js';
import { composeReducers } from './reducers.js';
import { createDefaultUpcasterRegistry } from './upcasters.js';

const defaultReducers = composeReducers(jobsRegistry, sessionsRegistry, discussRegistry, workflowRegistry);

export function createDefaultStoreReadContext(): StoreReadContext {
  return {
    schemas: defaultReducers.schemas,
    upcasters: createDefaultUpcasterRegistry(),
  };
}
