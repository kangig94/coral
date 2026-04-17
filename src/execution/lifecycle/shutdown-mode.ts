/**
 * Shutdown mode derived from reason. Determines child process and job handling:
 * - handoff: preserve wrappers/children for recovery; do NOT mark jobs as error or kill children
 * - hard: kill children and mark jobs as error (current behavior)
 */
export type ShutdownMode = 'handoff' | 'hard';

export function shutdownModeFromReason(reason: string): ShutdownMode {
  if (reason === 'replaced' || reason === 'sigterm') return 'handoff';
  return 'hard';
}
