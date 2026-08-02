import type { ReadonlyDatabase } from '../store/read-port.js';
import { providerSessionProvider, type ProviderSession } from './entry.js';
import { listProjectionSessionEntries, readProjectionProviderSession } from './projections.js';

type SessionLookupRef = {
  sessionId: string;
  provider: string;
};

export interface SessionLookup {
  listSessionRefs(onInvalidRow?: (sessionId: string | null, error: unknown) => void): SessionLookupRef[];
  readProviderSession(sessionId: string): ProviderSession | null;
}

export function createProjectionSessionLookup(db: ReadonlyDatabase): SessionLookup {
  return {
    listSessionRefs(onInvalidRow): SessionLookupRef[] {
      return listProjectionSessionEntries(db, undefined, undefined, onInvalidRow).map((entry) => ({
        sessionId: entry.sessionId,
        provider: providerSessionProvider(entry),
      }));
    },
    readProviderSession(sessionId: string): ProviderSession | null {
      return readProjectionProviderSession(db, sessionId);
    },
  };
}
