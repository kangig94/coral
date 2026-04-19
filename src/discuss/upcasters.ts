import type { UpcasterRegistry } from '../store/envelope.js';

export function registerDiscussUpcasters(_registry: UpcasterRegistry): void {
  // no upcasters yet; body_version=1 is current for all discuss events
}
