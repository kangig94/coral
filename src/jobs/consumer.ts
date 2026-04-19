import type BetterSqlite3 from 'better-sqlite3';

import type { ConsumerDriver } from '../coordinator/consumer-driver.js';
import { registerJournalProjectionConsumer } from '../store/projection-consumer.js';
import { jobsRegistry } from './events.js';

export function registerJobsConsumer(
  driver: ConsumerDriver,
  db: BetterSqlite3.Database,
): void {
  registerJournalProjectionConsumer(driver, db, 'jobs', jobsRegistry);
}
