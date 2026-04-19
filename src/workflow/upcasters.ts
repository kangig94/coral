import type { UpcasterRegistry } from '../store/envelope.js';

export function registerWorkflowUpcasters(_registry: UpcasterRegistry): void {
  // no upcasters yet; body_version=1 is current for all workflow events
}
