import { UpcasterRegistry } from './envelope.js';
import { registerJobsUpcasters } from '../jobs/upcasters.js';
import { registerSessionsUpcasters } from '../sessions/upcasters.js';
import { registerDiscussUpcasters } from '../discuss/upcasters.js';
import { registerWorkflowUpcasters } from '../workflow/upcasters.js';

/**
 * Build the canonical UpcasterRegistry with all domain upcasters registered.
 * Used by coordinator composition and by non-coordinator consumers (CLI, tests)
 * that need an upcast-aware read context.
 */
export function createDefaultUpcasterRegistry(): UpcasterRegistry {
  const registry = new UpcasterRegistry();
  registerJobsUpcasters(registry);
  registerSessionsUpcasters(registry);
  registerDiscussUpcasters(registry);
  registerWorkflowUpcasters(registry);
  return registry;
}
