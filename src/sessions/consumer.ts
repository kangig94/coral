import type BetterSqlite3 from 'better-sqlite3';

import {
  registerJournalProjectionConsumer,
  type JournalConsumerRegistrar,
  type ProjectionConsumerHandle,
} from '../store/projection-consumer.js';
import { sessionsRegistry } from './events.js';

export function registerSessionsConsumer(
  driver: JournalConsumerRegistrar,
  db: BetterSqlite3.Database,
): ProjectionConsumerHandle {
  return registerJournalProjectionConsumer(driver, db, 'sessions', sessionsRegistry);
}
