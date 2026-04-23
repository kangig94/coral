import type BetterSqlite3 from 'better-sqlite3';

import {
  registerJournalProjectionConsumer,
  type JournalConsumerRegistrar,
  type ProjectionConsumerHandle,
} from '../store/projection-consumer.js';
import { discussRegistry } from './store-registry.js';

export function registerDiscussConsumer(
  driver: JournalConsumerRegistrar,
  db: BetterSqlite3.Database,
): ProjectionConsumerHandle {
  return registerJournalProjectionConsumer(driver, db, 'discuss', discussRegistry);
}
