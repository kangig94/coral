import { startRecoveryPhase } from '../../recovery/phase-observation.js';
import type { TimerHandle } from '../../infra/port-types.js';
import type { Runtime } from '../../runtime/ports.js';
import { reconcileHandoffRoutingStatus } from './status.js';

export const HANDOFF_ROUTING_RECONCILIATION_INTERVAL_MS = 1_000;

export function createHandoffRoutingReconciler(
  runtime: Runtime,
  path: string,
  onError: () => void,
  observation?: { bootId: string; log(message: string): void },
) {
  let lifetime: AbortController | null = null;
  let timer: TimerHandle | null = null;
  let sweep: Promise<void> | null = null;
  let failed = false;

  function tick(): void {
    if (lifetime === null || sweep !== null) return;
    const signal = lifetime.signal;
    const phase = startRecoveryPhase({
      time: runtime.time,
      log: observation?.log ?? (() => {}),
      bootId: observation?.bootId ?? 'unknown',
      kind: 'background',
      phase: 'handoff-routing-reconciliation',
    });
    sweep = reconcileHandoffRoutingStatus(runtime, path, signal, phase)
      .then(() => {
        phase.finish();
        failed = false;
      })
      .catch(() => {
        phase.finish('failed');
        if (!failed && !signal.aborted) onError();
        failed = true;
      })
      .finally(() => {
        sweep = null;
      });
  }

  return {
    start(): void {
      if (lifetime !== null) return;
      lifetime = new AbortController();
      tick();
      timer = runtime.time.setInterval(tick, HANDOFF_ROUTING_RECONCILIATION_INTERVAL_MS);
      timer.unref?.();
    },
    stop(): void {
      runtime.time.clearInterval(timer);
      timer = null;
      lifetime?.abort();
      lifetime = null;
    },
  };
}
