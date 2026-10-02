import type { Runtime } from '../../../runtime/ports.js';
import type { AttemptAcknowledgment, SuccessionAttempt } from '../attempt-child.js';
import { TransientCommitFailure } from './failure.js';

const ATTEMPT_READY_TIMEOUT_MS = 10_000;

export const waitForAttemptReady = (
  runtime: Runtime,
  attempt: SuccessionAttempt,
): Promise<Extract<AttemptAcknowledgment, { kind: 'ready' }>> =>
  new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = (): void => {};
    const timeout = runtime.time.setTimeout(
      () => finish(new TransientCommitFailure('Successor did not report read-only readiness.')),
      ATTEMPT_READY_TIMEOUT_MS,
    );
    const onExit = (): void => finish(new TransientCommitFailure('Successor exited before readiness.'));
    attempt.child.once('exit', onExit);
    unsubscribe = attempt.onAcknowledgment((acknowledgment) => {
      if (acknowledgment.kind === 'hold') finish(new Error(acknowledgment.reason));
      if (acknowledgment.kind === 'ready') finish(null, acknowledgment);
    });
    if (settled) unsubscribe();
    function finish(error: Error | null, ready?: Extract<AttemptAcknowledgment, { kind: 'ready' }>): void {
      if (settled) return;
      settled = true;
      runtime.time.clearTimeout(timeout);
      unsubscribe();
      attempt.child.off('exit', onExit);
      if (error !== null) reject(error);
      else if (ready !== undefined) resolve(ready);
    }
  });
