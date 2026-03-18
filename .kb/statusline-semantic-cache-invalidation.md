# Statusline Semantic Cache Invalidation
## Rule
TTL-based cache alone cannot detect when rate-limit window data becomes stale. `isFreshCacheEntry` must check whether any `resets_at` timestamp crossed between cache write time (`cache.ts`) and current time. When `resetMs > cache.ts && resetMs <= now`, the cache is semantically stale regardless of TTL — invalidate and refetch.
## Why
Without this check, the statusline shows old utilization percentage (e.g., `5h: 90%`) for up to 3 minutes after a window resets. If combined with persistent fetch failures (e.g., OAuth token expiration), the old percentage displays indefinitely with no visual indication of staleness.
## Pattern
Right:
```javascript
function isFreshCacheEntry(cache, now = Date.now()) {
  if (now - cache.ts > getCacheTtlMs(cache)) return false;
  if (cache.data && !cache.error) {
    for (const rt of [cache.data.fiveHourResetsAt, cache.data.weeklyResetsAt]) {
      if (!rt) continue;
      const resetMs = new Date(rt).getTime();
      if (Number.isFinite(resetMs) && resetMs > cache.ts && resetMs <= now) return false;
    }
  }
  return true;
}
```

Wrong:
```javascript
function isFreshCacheEntry(cache, now = Date.now()) {
  return now - cache.ts <= getCacheTtlMs(cache); // TTL only — misses window resets
}
```
