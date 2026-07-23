import type { Database } from '../store/db.js';

import type { ProviderSession } from './entry.js';
import { readProjectionProviderSession } from './projections.js';

export function readProviderSessionById(db: Database, sessionId: string): ProviderSession {
  const entry = readProjectionProviderSession(db, sessionId);

  if (entry === null) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  return entry;
}
