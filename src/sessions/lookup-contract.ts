export type SessionLookupRef = {
  sessionId: string;
  provider: string;
  shardDir: string;
};

export interface SessionLookup {
  listSessionRefs(): SessionLookupRef[];
  lookupSessionShard(sessionId: string): { shardDir: string; provider: string } | null;
}
