import type { InvocationContext } from '../runtime/invocation-context.js';
import type { PersistedDiscussSnapshot } from './events.js';
import type { DiscussContext } from './shell/context.js';

export type RecoveredDiscussResume = {
  ctx: DiscussContext;
  sessionId: string;
  invocationCtx: InvocationContext;
};

export function isWithinLiveSessionBoundary(snapshot: PersistedDiscussSnapshot): boolean {
  return snapshot.state.status !== 'ended' || snapshot.runtime.controlPhase !== 'idle';
}
