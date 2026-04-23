import { UpcasterRegistry } from './envelope.js';

/**
 * Build the canonical UpcasterRegistry for future Journal schema evolution.
 * Used by coordinator composition and by non-coordinator consumers (CLI, tests)
 * that need an upcast-aware read context.
 */
export function createDefaultUpcasterRegistry(): UpcasterRegistry {
  return new UpcasterRegistry();
}
