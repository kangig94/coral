import type { Database } from '../store/db.js';

import type { SessionEntry } from './entry.js';
import { readProjectionSessionEntry } from './projections.js';

export function readSessionEntryById(db: Database, sessionId: string): SessionEntry {
  const entry = readProjectionSessionEntry(db, sessionId);

  if (entry === null) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  return entry;
}
