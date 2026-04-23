import type BetterSqlite3 from 'better-sqlite3';

import {
  registerJournalProjectionConsumer,
  type JournalConsumerRegistrar,
  type ProjectionConsumerHandle,
} from '../store/projection-consumer.js';
import { workflowRegistry } from './events.js';

export function registerWorkflowConsumer(
  driver: JournalConsumerRegistrar,
  db: BetterSqlite3.Database,
): ProjectionConsumerHandle {
  return registerJournalProjectionConsumer(driver, db, 'workflow', workflowRegistry);
}
