import type BetterSqlite3 from 'better-sqlite3';

import type { ConsumerDriver } from '../coordinator/consumer-driver.js';
import { registerJournalProjectionConsumer } from '../store/projection-consumer.js';
import { discussRegistry } from './store-registry.js';

export function registerDiscussConsumer(
  driver: ConsumerDriver,
  db: BetterSqlite3.Database,
): void {
  registerJournalProjectionConsumer(driver, db, 'discuss', discussRegistry);
}
