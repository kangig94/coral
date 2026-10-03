import { SUCCESSION_PAUSE_ROLLING_WINDOW_MS } from '../../live/admission.js';
import { TRANSIENT_RETRY_BASE_MS } from '../attempt-retry.js';
import type { CommitState, SuccessionCommitPorts } from './index.js';
import { TransientCommitFailure } from './failure.js';

export function createCommitPause(ports: SuccessionCommitPorts, state: CommitState) {
  function openPause(attemptId: string, admissionRevision: number) {
    if (state.pausedAttemptId !== null) ports.launchCoordinator.endSuccessionCommitWindow(state.pausedAttemptId);
    state.pausedAttemptId = null;
    const pause = ports.launchCoordinator.beginSuccessionCommitWindow(attemptId, admissionRevision);
    if (pause.kind !== 'paused') {
      throw new TransientCommitFailure(
        `Succession admission pause was ${pause.reason}.`,
        pause.reason === 'aggregate-budget-exhausted' ? SUCCESSION_PAUSE_ROLLING_WINDOW_MS : TRANSIENT_RETRY_BASE_MS,
        pause.reason === 'stale-preparation',
      );
    }
    state.pausedAttemptId = attemptId;
    return { deadlineAtMs: pause.deadlineAtMs, deadlineMonotonicMs: pause.deadlineMonotonicMs };
  }

  function closePause(): void {
    if (state.pausedAttemptId !== null) ports.launchCoordinator.endSuccessionCommitWindow(state.pausedAttemptId);
    state.pausedAttemptId = null;
  }

  return { openPause, closePause };
}
