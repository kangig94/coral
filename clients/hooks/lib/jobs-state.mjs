// Shared state vocabulary for coral-backend job snapshots.
// Producer (pre-compact) writes files; consumer (post-compact) reads them.
// Centralizing the filename shape keeps the two sides from drifting.

// This deployed standalone hook cannot import the TypeScript runtime partition from src/jobs/phase.ts.
const LIVE_PHASES = new Set(['queued', 'launching', 'running']);
export const SNAPSHOT_PREFIX = 'active-jobs-';
export const SNAPSHOT_SUFFIX = '.json';
export const SNAPSHOT_TTL_MS = 10 * 60_000;

export function isLivePhase(phase) {
  return LIVE_PHASES.has(phase);
}

export function snapshotFileName(capturedAtMs, salt) {
  return `${SNAPSHOT_PREFIX}${capturedAtMs}-${salt}${SNAPSHOT_SUFFIX}`;
}
