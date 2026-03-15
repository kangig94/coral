# Execution Session Cache Needs Shared Invalidation Authority
Promoted: 2026-03-15 | Updated: 2026-03-15
## Rule
If `SessionManager.readEntry()` stops using per-read `statSync`, cache invalidation must stay authoritative across all `SessionManager` instances that can touch the same shard, not just within the instance that performed the write. A per-instance write-ahead cache is only safe when all writers and readers share the same invalidation channel or singleton ownership.
## Why
Coral keeps long-lived and short-lived `SessionManager` instances alive in the same backend process. If one instance writes a session file and another instance keeps a stale cached copy, runtime reads can silently return the wrong `activeJobId`, `version`, or `conversationRef`. The old `statSync` check is expensive, but it currently protects against that multi-instance drift.
## Pattern
Right:
```ts
class SessionCacheBus {
  invalidate(sessionId: string, shardHash: string): void { /* broadcast */ }
}

writeEntry(entry) {
  persist(entry);
  sharedCache.set(key(entry), entry);
  cacheBus.invalidate(entry.sessionId, shardHash);
}

readEntry(sessionId) {
  return sharedCache.get(key(sessionId)) ?? loadFromDisk(sessionId);
}
```

Wrong:
```ts
class SessionManager {
  private readonly cache = new Map();

  writeEntry(entry) {
    persist(entry);
    this.cache.set(entry.sessionId, entry); // only this instance knows
  }
}
```
