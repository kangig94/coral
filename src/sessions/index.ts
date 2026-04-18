export {
  DEFAULT_SESSION_CONTROLLER,
  providerInstructionSchema,
  sessionControllerFromProfile,
  sessionControllerProfileSchema,
  sessionEntrySchema,
  sessionStateSchema,
} from './entry.js';
export type {
  SessionController,
  SessionControllerProfile,
  SessionEntry,
  SessionHandle,
  SessionState,
} from './entry.js';

export { continuitySnapshotSchema, providerContinuityBlobSchema } from './continuity.js';
export type { ContinuitySnapshot, ProviderContinuityBlob } from './continuity.js';

export {
  sessionAdapterUnparseableFaultSchema,
  sessionCloseReasonSchema,
  sessionContinuityStateSchema,
  sessionInterruptedFaultSchema,
  sessionInterruptTriggerSchema,
  sessionProviderFailedFaultSchema,
  sessionProviderFailureReasonSchema,
} from './fault.js';
export type {
  SessionAdapterUnparseableFault,
  SessionCloseReason,
  SessionContinuityState,
  SessionFault,
  SessionInterruptedFault,
  SessionInterruptTrigger,
  SessionProviderFailedFault,
  SessionProviderFailureReason,
} from './fault.js';

export {
  sessionAdapterUnparseableBodySchema,
  sessionClosedBodySchema,
  sessionContinuityCheckpointedBodySchema,
  sessionInterruptedBodySchema,
  sessionOpenedBodySchema,
  sessionProviderFailedBodySchema,
  sessionsRegistry,
} from './events.js';
export type {
  SessionAdapterUnparseableBody,
  SessionClosedBody,
  SessionContinuityCheckpointedBody,
  SessionInterruptedBody,
  SessionOpenedBody,
  SessionProviderFailedBody,
} from './events.js';

export type { ProjectionSessionRow } from './projections.js';

export { sessionsCommands, sessionsQueries } from './api.js';
export type { SessionListFilter } from './api.js';

export { SessionManager } from './shell/store.js';
export type { SessionAllocateOptions, SessionContinuityMutation } from './shell/store.js';
export { getSessionById, listSessionShards, readSessionRefs, resolveSession } from './shell/resolve.js';
export type { SessionResolveRef } from './shell/resolve.js';
