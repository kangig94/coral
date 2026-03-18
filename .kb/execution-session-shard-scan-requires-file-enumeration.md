# Execution Session Shard Scans Require File Enumeration
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
When startup recovery needs to inspect every session inside a discovered execution shard, do not expect `SessionManager.openShard()` to provide a shard-wide listing surface. Enumerate `*.json` session files in the shard, extract `{ sessionId, provider }`, and then re-read each entry through the shard manager before deciding whether to clear `activeJobId`.
## Why
`openShard()` preserves the existing hash-dir boundary, but the public API is still provider-scoped (`get`/`list(provider)`). Recovery code that assumes a `listAll()`-style surface either cannot see every session or falls back to re-hashing shard paths through the normal constructor, which points at the wrong directory and silently leaves orphaned claims behind.
## Pattern
Right:
```typescript
for (const shardDir of SessionManager.listShards()) {
  const shard = SessionManager.openShard(shardDir);
  for (const file of readdirSync(shardDir)) {
    const ref = readSessionRef(file);
    if (!ref) continue;
    const session = shard.get(ref.provider, ref.sessionId);
    if (session?.activeJobId && isMissingJob(session.activeJobId)) {
      shard.releaseJob(session.sessionId, session.activeJobId);
    }
  }
}
```

Wrong:
```typescript
for (const shardDir of SessionManager.listShards()) {
  const shard = new SessionManager(shardDir);
  // Re-hashes the shard path and still does not expose every session.
}
```
