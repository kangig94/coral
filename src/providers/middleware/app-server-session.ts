import type {
  ProviderEventBody,
  ProviderMiddleware,
  ProviderRuntime,
  ProviderServerLease,
  ProviderServerSpec,
} from '../contract.js';
import { bindAppServerLease, getAppServerNotificationHandler, type AppServerContract } from '../app-server/driver.js';
import type { AppServerNotificationMessage, AppServerSubscriptionPhase, ProviderTransportClose } from '../protocol.js';

type DownstreamStep = IteratorResult<ProviderEventBody>;
type ClosedResult = { kind: 'closed'; closed: Error | void };
type NextResult = { kind: 'next'; step: DownstreamStep };
type NotificationSubscription = {
  startBeforeInitialize(): void;
  startAfterInitialize(): void;
  stop(): void;
};

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

function subscribeWithPhase(
  phase: AppServerSubscriptionPhase,
  lease: ProviderServerLease,
  handler: (message: AppServerNotificationMessage) => void,
): NotificationSubscription {
  let subscribed = false;
  let open = false;
  let unsubscribe = () => {};

  const start = (): void => {
    if (subscribed) {
      return;
    }

    subscribed = true;
    open = true;
    unsubscribe = lease.subscribe((message: AppServerNotificationMessage) => {
      if (!open) {
        return;
      }
      handler(message);
    });
  };

  return {
    startBeforeInitialize() {
      if (isBeforeInitialize(phase)) {
        start();
      }
    },
    startAfterInitialize() {
      if (!isBeforeInitialize(phase)) {
        start();
      }
    },
    stop() {
      if (!subscribed || !open) {
        return;
      }

      open = false;
      const currentUnsubscribe = unsubscribe;
      unsubscribe = () => {};
      try {
        currentUnsubscribe();
      } catch {
        /* ignore cleanup failures */
      }
    },
  };
}

function raceNextAndClosed(
  pendingNext: Promise<DownstreamStep>,
  pendingClosed: Promise<ClosedResult>,
): Promise<ClosedResult | NextResult> {
  return Promise.race([pendingClosed, pendingNext.then((step): NextResult => ({ kind: 'next', step }))]);
}

async function teardownSession(options: {
  removeAbortRelay: () => void;
  notifications: NotificationSubscription;
  iterator: AsyncIterator<ProviderEventBody> | null;
  downstreamSettled: boolean;
  clearBoundLease: () => void;
  lease: ProviderServerLease;
}): Promise<void> {
  options.removeAbortRelay();
  options.notifications.stop();

  if (options.iterator && !options.downstreamSettled && typeof options.iterator.return === 'function') {
    try {
      await options.iterator.return();
    } catch {
      /* ignore downstream cleanup failures */
    }
  }

  options.clearBoundLease();
  try {
    options.lease.release();
  } catch {
    /* ignore cleanup failures */
  }
}

export function appServerSession(contract: AppServerContract): ProviderMiddleware {
  return (next) =>
    async function* appServerSessionProvider(request, runtime) {
      if (!runtime.storage) {
        throw new Error('appServerSession requires runtime.storage to build the provider server spec.');
      }
      const spec: ProviderServerSpec = contract.buildServerSpec(request, runtime.persistedContinuity, {
        storage: runtime.storage,
      });
      const lease: ProviderServerLease = await runtime.acquireServer(spec);
      const clearBoundLease = bindAppServerLease(runtime, lease);
      const removeAbortRelay = installAbortRelay(runtime, lease, contract.interrupt.bind(contract));
      const notifications = subscribeWithPhase(contract.subscriptionPhase, lease, (message) => {
        getAppServerNotificationHandler(runtime)?.(message);
        contract.onNotification?.(message);
      });

      let iterator: AsyncIterator<ProviderEventBody> | null = null;
      let downstreamSettled = false;
      let transportClosed = false;

      try {
        notifications.startBeforeInitialize();
        iterator = next(request, runtime)[Symbol.asyncIterator]();
        let pendingNext: Promise<DownstreamStep> | null = iterator.next();
        notifications.startAfterInitialize();

        const pendingClosed: Promise<ClosedResult> = lease.closed.then((closed) => ({
          kind: 'closed',
          closed,
        }));

        while (pendingNext !== null) {
          let step: DownstreamStep | undefined;

          if (!transportClosed) {
            const winner = await raceNextAndClosed(pendingNext, pendingClosed);

            if (winner.kind === 'closed') {
              transportClosed = true;
              notifications.stop();
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
            notifications.stop();
            yield event;
            return;
          }

          yield event;
          pendingNext = iterator.next();
        }
      } finally {
        await teardownSession({
          removeAbortRelay,
          notifications,
          iterator,
          downstreamSettled,
          clearBoundLease,
          lease,
        });
      }
    };
}
