import type BetterSqlite3 from 'better-sqlite3';

import type { ConsumerHandle, JournalConsumerRegistration } from '../coordinator/consumer-driver.js';
import type { StoreReadContext } from './body-codec.js';
import { getEventsSince } from './queries/events.js';
import { applyReducer, composeReducers, type ComposedReducers, type DomainEventRegistry } from './reducers.js';
import { createDefaultUpcasterRegistry } from './upcasters.js';

type JournalConsumerRegistrar = {
  register(reg: JournalConsumerRegistration): ConsumerHandle;
};

async function applyProjectionRange(
  db: BetterSqlite3.Database,
  reducers: ComposedReducers,
  eventTypes: ReadonlySet<string>,
  fromSeq: number,
  upToSeq: number,
  readCtx: StoreReadContext,
): Promise<void> {
  let cursor = fromSeq;

  while (cursor < upToSeq) {
    const page = getEventsSince(db, cursor, {}, 1_000, readCtx);
    const scoped = page.events.filter((event) => event.seq <= upToSeq && eventTypes.has(event.type));
    if (scoped.length > 0) {
      const txn = db.transaction(() => {
        for (const event of scoped) {
          applyReducer(db, event, reducers);
        }
      });
      txn.immediate();
    }

    if (page.nextCursor <= cursor) {
      break;
    }

    cursor = page.nextCursor;
  }
}

export function registerJournalProjectionConsumer(
  driver: JournalConsumerRegistrar,
  db: BetterSqlite3.Database,
  consumerId: string,
  registry: DomainEventRegistry,
): ConsumerHandle {
  const reducers = composeReducers(registry);
  const eventTypes = new Set(registry.types);
  const readCtx: StoreReadContext = {
    schemas: reducers.schemas,
    upcasters: createDefaultUpcasterRegistry(),
  };
  return driver.register({
    id: consumerId,
    authority: 'journal',
    apply: ({ fromSeq, upToSeq }) => applyProjectionRange(db, reducers, eventTypes, fromSeq, upToSeq, readCtx),
  });
}
