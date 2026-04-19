import type { UpcasterRegistry } from '../store/envelope.js';

/**
 * Register jobs-domain upcasters on the shared UpcasterRegistry.
 * Currently identity — all jobs events are v1. Add entries here when
 * bumping body_version on any jobs event type.
 */
export function registerJobsUpcasters(_registry: UpcasterRegistry): void {
  // no upcasters yet; body_version=1 is current for all jobs events
}
