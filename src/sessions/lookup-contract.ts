import type { SessionEntry } from './entry.js';

export type SessionLookupRef = {
  sessionId: string;
  provider: string;
};

export interface SessionLookup {
  listSessionRefs(): SessionLookupRef[];
  readSessionEntry(sessionId: string): SessionEntry | null;
}
