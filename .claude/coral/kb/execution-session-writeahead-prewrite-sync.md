# Session Write-Ahead Cache Must Sync Before Blind Writes
Promoted: 2026-03-15 | Updated: 2026-03-15
## Rule
If `SessionManager` uses a shard-level invalidation stamp instead of per-read `statSync`, every write path must synchronize its local cache against the shared shard stamp before updating write-ahead cache state. This especially matters for blind writes such as `allocate()` that do not start with a fresh read: the write path itself must clear any stale full-shard cache before it bumps the shard stamp and stores the newly written entry.
## Why
Without a pre-write sync, an instance can hold a hydrated but stale cache, perform a write that only updates the touched entry, and then mark itself current again by advancing its local shard stamp. At that point unrelated cached sessions look authoritative even though another manager already changed them.
## Pattern
```typescript
function writeEntry(entry: SessionEntry): void {
  syncCacheWithShardStamp();
  persist(entry);
  shardStamp = bumpShardStamp();
  cache.set(entry.sessionId, clone(entry));
}
```

```typescript
function allocate(...): SessionEntry {
  // Wrong if local cache might be stale:
  persist(entry);
  cache.set(entry.sessionId, clone(entry));
  shardStamp = bumpShardStamp();
  return entry;
}
```
