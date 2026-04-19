import type BetterSqlite3 from 'better-sqlite3';

import { getEventsSince } from './queries/events.js';
import { applyReducer, composeReducers, type ComposedReducers, type DomainEventRegistry } from './reducers.js';

type JournalConsumerRegistration = {
  readonly id: string;
  readonly authority: 'journal';
  apply(ctx: { fromSeq: number; upToSeq: number; db: BetterSqlite3.Database }): Promise<void>;
};

type JournalConsumerRegistrar = {
  register(reg: JournalConsumerRegistration): void;
};

async function applyProjectionRange(
  db: BetterSqlite3.Database,
  reducers: ComposedReducers,
  eventTypes: ReadonlySet<string>,
  fromSeq: number,
  upToSeq: number,
): Promise<void> {
  let cursor = fromSeq;

  while (cursor < upToSeq) {
    const page = getEventsSince(db, cursor, {}, 1_000);
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
): void {
  const reducers = composeReducers(registry);
  const eventTypes = new Set(registry.types);
  driver.register({
    id: consumerId,
    authority: 'journal',
    apply: ({ fromSeq, upToSeq }) => applyProjectionRange(db, reducers, eventTypes, fromSeq, upToSeq),
  });
}
