import type { EventBusEvents, TypedEventBus } from '../event-bus.js';
import type { SessionIndex } from '../session-index.js';

type SessionIndexSubscriptionInstaller = {
  install(): () => void;
};

type CreateSessionIndexSubscriptionContext = {
  eventBus: TypedEventBus;
  sessionIndex: SessionIndex;
};

export function createSessionIndexSubscription({
  eventBus,
  sessionIndex,
}: CreateSessionIndexSubscriptionContext): SessionIndexSubscriptionInstaller {
  const onSessionIndexUpdated = (payload: EventBusEvents['session:updated']): void => {
    if (!sessionIndex.hasShard(payload.shardHash)) {
      sessionIndex.discoverShard(payload.shardHash);
    }
    sessionIndex.invalidate(payload.shardHash, payload.sessionId);
  };

  return {
    install(): () => void {
      let installed = true;
      eventBus.on('session:updated', onSessionIndexUpdated);

      return () => {
        if (!installed) {
          return;
        }
        installed = false;
        eventBus.off('session:updated', onSessionIndexUpdated);
      };
    },
  };
}
