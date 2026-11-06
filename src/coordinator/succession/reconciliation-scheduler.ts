import { createBackgroundPhaseObserver, type RecoveryObservation } from '../../recovery/phase-observation.js';
import type { Runtime } from '../../runtime/ports.js';
import type { SuccessionDecision } from './reconciler/index.js';

export function createSuccessionReconciliationScheduler(input: {
  time: Runtime['time'];
  retryIntervalMs: number;
  observation?: { bootId: string; log(message: string): void };
  subscribe?: (notify: () => void) => () => void;
  runPass: (observation?: RecoveryObservation) => Promise<SuccessionDecision>;
  onError?: (error: unknown) => void;
}): Readonly<{
  reconcile: () => Promise<SuccessionDecision>;
  notifyObligationChange: () => void;
  dispose: () => void;
}> {
  const lifetime = new AbortController();
  const startPhase =
    input.observation === undefined
      ? undefined
      : createBackgroundPhaseObserver({
          ...input.observation,
          time: input.time,
          phase: 'succession-reconciliation',
        });
  let disposed = false;
  let running: Promise<SuccessionDecision> | null = null;
  let changedDuringPass = false;
  const notifyObligationChange = (): void => {
    if (disposed) return;
    queueMicrotask(() => {
      if (disposed) return;
      void reconcile().catch((error: unknown) => input.onError?.(error));
    });
  };
  const reconcile = (): Promise<SuccessionDecision> => {
    if (disposed) return Promise.resolve({ kind: 'deferred', reason: 'reconciliation-scheduler-disposed' });
    if (running !== null) {
      changedDuringPass = true;
      return running;
    }
    const observation = startPhase?.(lifetime.signal);
    const pass = input.runPass(observation);
    void pass.then(
      () => observation?.finish(disposed ? 'cancelled' : 'complete'),
      () => observation?.finish(disposed ? 'cancelled' : 'failed'),
    );
    const pending = pass.finally(() => {
      running = null;
      if (!changedDuringPass) return;
      changedDuringPass = false;
      notifyObligationChange();
    });
    running = pending;
    return pending;
  };
  const unsubscribe = input.subscribe?.(notifyObligationChange);
  const retryTimer = input.time.setInterval(notifyObligationChange, input.retryIntervalMs);
  retryTimer.unref?.();
  queueMicrotask(notifyObligationChange);
  return {
    reconcile,
    notifyObligationChange,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      changedDuringPass = false;
      input.time.clearInterval(retryTimer);
      unsubscribe?.();
    },
  };
}
