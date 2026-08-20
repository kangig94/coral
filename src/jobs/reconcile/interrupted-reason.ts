// Domain-neutral recovery vocabulary. Lives in jobs/reconcile because the
// reason is a property of *recovery* (jobs/reconcile owns the recovery state
// machine); coordinator and the recovery service consume it. jobs/ does not
// have to import upward from coordinator/.

/**
 * Why startup recovery is finalizing app-server jobs:
 * - `'restart'`: ordinary process restart recovery (default).
 * - `'handoff'`: replacement daemon swap; the new daemon's startup recovery
 *   finalizes interrupted app-server jobs after the bind-with-handoff loop
 *   acquires the socket.
 */
export type InterruptedAppServerReason = 'restart' | 'handoff';

/**
 * App-server interruption probe outcome — used by the recovery service to
 * record terminal cause. Co-located with the reason because both flow
 * through the same finalize path.
 */
export type InterruptedProbeOutcome = 'verified' | 'missing' | 'unavailable' | 'waiting';
