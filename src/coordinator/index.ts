/**
 * Public coordinator surface for discovery records, caller context, and embedded server startup.
 * Internal composition and live modules stay private to direct `src/coordinator/*` imports.
 */
export {
  currentEventMetadata,
  getCallerContext,
  requireCallerContext,
  withCallerContext,
} from './caller-context.js';
export type { CoordinatorCallerContext } from './caller-context.js';
export type { CoordinatorDiscoveryRecord } from './discovery.js';
export { createCoordinatorServer } from './coordinator.js';
export type {
  BackendServerController,
  BackendServerOptions,
  CoordinatorServerController,
  CoordinatorServerOptions,
} from './coordinator.js';
