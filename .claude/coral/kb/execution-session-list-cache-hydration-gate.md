# SessionManager List Cache Needs A Full-Shard Hydration Gate
Promoted: 2026-03-15 | Updated: 2026-03-15
## Rule
`SessionManager.list()` may only iterate cached session ids after that manager has completed a full shard enumeration. Point reads and writes create a partial cache, not a listing authority, so cache-backed listing needs an explicit hydration signal that distinguishes "full shard inventory loaded" from "some entries touched".
## Why
Without a hydration gate, switching `list()` to cached rows silently drops sessions that were never individually read or written through the current manager instance. The cache looks populated enough to pass small tests, but production listing becomes order-dependent: whichever sessions happened to be touched first appear, and untouched siblings disappear until a later disk scan repairs them.
## Pattern
Right:
```ts
if (!shardCache.hydratedForList) {
  hydrateShardListingFromDisk();
}
return [...shardCache.sessionIds].map((sessionId) => shardCache.entries.get(sessionId));
```

Wrong:
```ts
// Point reads/writes populated some cache rows, so reuse them for list()
return [...entryCache.values()];
```
