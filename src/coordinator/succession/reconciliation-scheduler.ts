import type { Runtime } from '../../runtime/ports.js';
import type { SuccessionDecision } from './reconciler/index.js';

export function createSuccessionReconciliationScheduler(input: {
  time: Runtime['time'];
  retryIntervalMs: number;
  subscribe?: (notify: () => void) => () => void;
  runPass: () => Promise<SuccessionDecision>;
  onError?: (error: unknown) => void;
}): Readonly<{
  reconcile: () => Promise<SuccessionDecision>;
  notifyObligationChange: () => void;
  dispose: () => void;
}> {
  let disposed = false;
  let running: Promise<SuccessionDecision> | null = null;
  let changedDuringPass = false;
  const notifyObligationChange = (): void => {
    if (disposed) return;
    queueMicrotask(() => {
      void reconcile().catch((error: unknown) => input.onError?.(error));
    });
  };
  const reconcile = (): Promise<SuccessionDecision> => {
    if (running !== null) {
      changedDuringPass = true;
      return running;
    }
    const pending = input.runPass().finally(() => {
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
      input.time.clearInterval(retryTimer);
      unsubscribe?.();
    },
  };
}
