// Phase 2 sessions compatibility shim.
// The authoritative implementation now lives under src/sessions/.

export {
  SessionManager,
  type SessionAllocateOptions,
  type SessionContinuityMutation,
} from '../sessions/shell/store.js';
export { getSessionById, listSessionShards } from '../sessions/shell/resolve.js';
