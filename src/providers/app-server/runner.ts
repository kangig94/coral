import { errorMessage, nowIsoString } from '../../shared/utils.js';
import {
  providerProgressEvent,
  streamProviderEvents,
  type ProviderEventBody,
  type ProviderRequest,
  type ProviderTerminalEventBody,
} from '../protocol.js';
import { requireAppServerRuntime, type ProviderRuntime } from '../provider-contracts.js';
import type { AppServerSessionDriver, DriverContext, TurnOutcome } from './driver.js';

export function runAppServerTurn<TState>(
  driver: AppServerSessionDriver<TState>,
  request: ProviderRequest,
  runtime: ProviderRuntime,
): AsyncIterable<ProviderEventBody> {
  return streamProviderEvents(async (emit) => {
    const { acquireServer, checkpointRecovery } = requireAppServerRuntime(runtime, driver.name);
    const spec = driver.buildServerSpec(request, runtime.persistedContinuity);
    const lease = await acquireServer(spec);
    const ctx: DriverContext = {
      lease,
      runtime,
      checkpointRecovery,
      emitProgress: (message: string) => {
        emit(providerProgressEvent(message, nowIsoString()));
      },
    };

    const state = driver.createInitialState(ctx, request);
    let settled = false;
    let notificationsOpen = true;
    let unsubscribe = () => {};

    const stopNotifications = (): void => {
      if (!notificationsOpen) {
        return;
      }
      notificationsOpen = false;
      const previous = unsubscribe;
      unsubscribe = () => {};
      try {
        previous();
      } catch {
        /* ignore */
      }
    };

    const subscribe = (): (() => void) =>
      lease.subscribe((message) => {
        if (!notificationsOpen) {
          return;
        }
        driver.applyNotification(state, message);
      });

    const settle = (produce: () => TurnOutcome): TurnOutcome | undefined => {
      if (settled) {
        return undefined;
      }
      settled = true;
      stopNotifications();
      return produce();
    };

    const finalize = (outcome: TurnOutcome): ProviderTerminalEventBody => {
      stopNotifications();
      if (outcome.kind === 'failed') {
        const base = driver.finalize(state, outcome);
        return {
          ...base,
          outcome: {
            kind: 'legacy_fault',
            fault: {
              kind: 'provider_request_failed',
              provider: driver.faultProviderName,
              message: outcome.message,
            },
          },
        };
      }
      return driver.finalize(state, outcome);
    };

    const onAbort = (): void => {
      void driver.requestInterrupt(ctx, state).catch(() => {});
    };

    runtime.signal.addEventListener('abort', onAbort, { once: true });

    try {
      if (driver.subscriptionPhase === 'beforeInitialize') {
        unsubscribe = subscribe();
      }

      const initialized = await driver.initialize(ctx, state, request);
      if (initialized.terminal) {
        emit(finalize(initialized.terminal));
        return;
      }
      if (driver.subscriptionPhase === 'afterInitialize') {
        unsubscribe = subscribe();
      }
      if (runtime.signal.aborted) {
        emit(finalize({ kind: 'aborted', reason: 'signal_abort' }));
        return;
      }

      const started = await driver.startTurn(ctx, state, request);
      if (started.terminal) {
        emit(finalize(started.terminal));
        return;
      }
      if (runtime.signal.aborted) {
        await driver.requestInterrupt(ctx, state).catch(() => {});
      }

      const outcome = await Promise.race([
        driver.awaitTurnOutcome(state).then((terminal) => settle(() => terminal)),
        lease.closed.then((closed) => settle(() => driver.onTransportClosed(state, closed))),
      ]);

      if (!outcome) {
        throw new Error('runner settlement lost both terminal branches unexpectedly');
      }

      emit(finalize(outcome));
    } catch (error) {
      if (runtime.signal.aborted) {
        emit(finalize({ kind: 'aborted', reason: 'signal_abort' }));
        return;
      }
      emit(finalize({ kind: 'failed', message: errorMessage(error) }));
    } finally {
      runtime.signal.removeEventListener('abort', onAbort);
      try {
        stopNotifications();
      } catch {
        /* defense-in-depth */
      }
      lease.release();
    }
  });
}
