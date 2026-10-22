import type { Database } from '../../store/db.js';

import type { JobConversation } from './entry.js';
import { readProjectionJobConversation } from './projections.js';

export function readJobConversationById(db: Database, jobId: string): JobConversation {
  const entry = readProjectionJobConversation(db, jobId);

  if (entry === null) {
    throw new Error(`Provider job not found: ${jobId}`);
  }

  return entry;
}
