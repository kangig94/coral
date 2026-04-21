import type {
  ProviderEventBody,
  ProviderMiddleware,
  ProviderRuntime,
  ProviderServerLease,
  ProviderServerSpec,
} from '../contract.js';
import { bindAppServerLease, type AppServerContract } from '../app-server/driver.js';
import type {
  AppServerNotificationMessage,
  AppServerSubscriptionPhase,
  ProviderTransportClose,
} from '../app-server/types.js';

type DownstreamStep = IteratorResult<ProviderEventBody>;
type ClosedResult = { kind: 'closed'; closed: Error | void };
type NextResult = { kind: 'next'; step: DownstreamStep };

function isBeforeInitialize(phase: AppServerSubscriptionPhase): boolean {
  return phase === 'beforeInitialize';
}

function toTransportClose(closed: Error | void): ProviderTransportClose {
  return {
    kind: 'transport_closed',
    error: closed ?? null,
  };
}

function installAbortRelay(
  runtime: ProviderRuntime,
  lease: ProviderServerLease,
  interrupt: (lease: ProviderServerLease) => Promise<void>,
): () => void {
  const onAbort = (): void => {
    void interrupt(lease).catch(() => {});
  };

  if (runtime.signal.aborted) {
    onAbort();
    return () => {};
  }

  runtime.signal.addEventListener('abort', onAbort, { once: true });
  return () => {
    runtime.signal.removeEventListener('abort', onAbort);
  };
}

export function appServerSession(
  contract: AppServerContract,
  mapInterrupt?: (lease: ProviderServerLease) => Promise<void>,
): ProviderMiddleware {
  return (next) =>
    async function* appServerSessionProvider(request, runtime) {
      const spec: ProviderServerSpec = contract.buildServerSpec(request, runtime.persistedContinuity);
      const lease: ProviderServerLease = await runtime.acquireServer(spec);
      const clearBoundLease = bindAppServerLease(runtime, lease);
      const removeAbortRelay = installAbortRelay(runtime, lease, mapInterrupt ?? contract.interrupt);

      let notificationsSubscribed = false;
      let notificationsOpen = false;
      let unsubscribe = () => {};
      let iterator: AsyncIterator<ProviderEventBody> | null = null;
      let downstreamSettled = false;
      let transportClosed = false;

      const startNotifications = (): void => {
        if (notificationsSubscribed) {
          return;
        }
        notificationsSubscribed = true;
        notificationsOpen = true;
        unsubscribe = lease.subscribe((message: AppServerNotificationMessage) => {
          if (!notificationsOpen) {
            return;
          }
          contract.onNotification?.(message);
        });
      };

      const stopNotifications = (): void => {
        if (!notificationsSubscribed || !notificationsOpen) {
          return;
        }
        notificationsOpen = false;
        const currentUnsubscribe = unsubscribe;
        unsubscribe = () => {};
        try {
          currentUnsubscribe();
        } catch {
          /* ignore cleanup failures */
        }
      };

      try {
        if (isBeforeInitialize(contract.subscriptionPhase)) {
          startNotifications();
        }

        iterator = next(request, runtime)[Symbol.asyncIterator]();
        let pendingNext: Promise<DownstreamStep> | null = iterator.next();

        if (!isBeforeInitialize(contract.subscriptionPhase)) {
          // Start the leaf turn before wiring after-initialize notifications.
          startNotifications();
        }

        const pendingClosed: Promise<ClosedResult> = lease.closed.then((closed) => ({
          kind: 'closed',
          closed,
        }));

        while (pendingNext !== null) {
          let step: DownstreamStep | undefined;

          if (!transportClosed) {
            const winner: ClosedResult | NextResult = await Promise.race([
              pendingClosed,
              pendingNext.then((nextStep): NextResult => ({ kind: 'next', step: nextStep })),
            ]);

            if (winner.kind === 'closed') {
              transportClosed = true;
              stopNotifications();
              runtime.continuityBridge.transportClosed(toTransportClose(winner.closed));
              continue;
            }

            step = winner.step;
          } else {
            step = await pendingNext;
          }

          pendingNext = null;

          if (step.done) {
            downstreamSettled = true;
            return;
          }

          const event = step.value;
          if (event.kind === 'terminal') {
            downstreamSettled = true;
            stopNotifications();
            yield event;
            return;
          }

          yield event;
          pendingNext = iterator.next();
        }
      } finally {
        removeAbortRelay();
        stopNotifications();
        if (iterator && !downstreamSettled && typeof iterator.return === 'function') {
          try {
            await iterator.return();
          } catch {
            /* ignore downstream cleanup failures */
          }
        }
        clearBoundLease();
        try {
          lease.release();
        } catch {
          /* ignore cleanup failures */
        }
      }
    };
}
