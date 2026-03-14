# Session Index Needs Lazy New-Shard Repair Until Root Discovery Is Exposed
Promoted: 2026-03-15 | Updated: 2026-03-15
## Rule
If the server-owned execution session index must notice shards created after startup but `SessionManager` only exposes per-shard invalidation plus `session:updated` payloads, repair unknown shards lazily with `SessionManager.listShards()` and hydrate only the newly discovered shard directories. Do not fall back to rescanning every session file in every shard on each request.
## Why
The current shared invalidation authority covers rows inside known shards, not the appearance of new shard directories. Without a lazy root repair path, a startup-hydrated index misses sessions created later in fresh shards. If you compensate by restoring the old full scan, `/api/sessions` and discuss-root discovery fall back onto the hot-path cost AC3 is supposed to remove.
## Pattern
Right:
```ts
function refreshIndex() {
  for (const shardDir of SessionManager.listShards()) {
    const shardHash = basename(shardDir);
    if (!knownShards.has(shardHash)) hydrateShard(shardDir);
  }
  rereadInvalidatedRows();
}
```

Wrong:
```ts
function listSessions() {
  return SessionManager.listShards().flatMap((shardDir) =>
    readdirSync(shardDir).map((file) => readSessionEntryLenient(join(shardDir, file))),
  );
}
```
