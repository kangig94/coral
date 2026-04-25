import type { PersistedDiscussSnapshot } from './events.js';

export function isWithinLiveSessionBoundary(snapshot: PersistedDiscussSnapshot): boolean {
  return snapshot.state.status !== 'ended' || snapshot.runtime.controlPhase !== 'idle';
}
