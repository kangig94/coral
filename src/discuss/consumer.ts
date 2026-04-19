import type BetterSqlite3 from 'better-sqlite3';

import type { ConsumerDriver } from '../coordinator/consumer-driver.js';
import { getEventsSince } from '../store/queries/events.js';
import { applyReducer, composeReducers } from '../store/reducers.js';
import { discussRegistry } from './store-registry.js';

const reducers = composeReducers(discussRegistry);
const discussTypes = new Set(discussRegistry.types);

async function applyDiscussProjectionRange(
  db: BetterSqlite3.Database,
  fromSeq: number,
  upToSeq: number,
): Promise<void> {
  let cursor = fromSeq;

  while (cursor < upToSeq) {
    const page = getEventsSince(db, cursor, {}, 1_000);
    const scoped = page.events.filter((event) => event.seq <= upToSeq && discussTypes.has(event.type));
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

export function registerDiscussConsumer(
  driver: ConsumerDriver,
  db: BetterSqlite3.Database,
): void {
  driver.register({
    id: 'discuss',
    authority: 'journal',
    apply: ({ fromSeq, upToSeq }) => applyDiscussProjectionRange(db, fromSeq, upToSeq),
  });
}
