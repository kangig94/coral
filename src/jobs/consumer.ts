import type BetterSqlite3 from 'better-sqlite3';

import {
  registerJournalProjectionConsumer,
  type JournalConsumerRegistrar,
  type ProjectionConsumerHandle,
} from '../store/projection-consumer.js';
import { jobsRegistry } from './events.js';

export function registerJobsConsumer(
  driver: JournalConsumerRegistrar,
  db: BetterSqlite3.Database,
): ProjectionConsumerHandle {
  return registerJournalProjectionConsumer(driver, db, 'jobs', jobsRegistry);
}
