# Discuss Summary Index Sync Repair Must Reuse Existing Locks Opportunistically
Promoted: 2026-03-15 | Updated: 2026-03-15
## Rule
When a synchronous discuss listing path needs to repair shared persisted metadata such as `summary-index.json` or the discuss project-root registry, it must reuse the existing promise-chain lock maps with a non-blocking try-lock. If the lock is already owned by an append, return correct snapshot-backed results and leave hydration incomplete so a later call can retry; do not introduce a second lock or block the sync API on an async queue.
## Why
`DiscussSessionStore.listSummariesFromIndex()` is synchronous, but the authoritative serialization for shared discovery metadata already lives in async promise-chain locks. A separate sync lock would race the append path, and waiting inside the sync listing method is not possible without distorting the API. The only coherent behavior is to reuse the same lock ownership and accept that repair is best-effort under contention.
## Pattern
Right:
```ts
const repaired = tryWithPromiseChainLockSync(projectDiscoveryLocks, projectRoot, () => {
  writeAtomicJson(summaryIndexPath, nextIndex);
});

if (repaired === null) {
  return listSummaries(); // correct fallback, retry hydration later
}
```

Wrong:
```ts
const syncMutex = new Mutex();
syncMutex.runExclusive(() => {
  writeAtomicJson(summaryIndexPath, nextIndex);
});
```
