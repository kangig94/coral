# Statusline Negative Cache Contract
## Rule
If a statusline cache needs to suppress retries after failures, the read path must preserve cache-entry state, not just return cached payload data. Returning only `cache.data` collapses two different states, "valid negative cache entry" and "cache miss", so failure TTLs and 429 backoff metadata cannot affect caller behavior.
## Why
Retry protection depends on the caller distinguishing "do not fetch yet" from "you may fetch now". When error entries are serialized as `{ data: null, error: true }` but the read helper returns only `null`, callers re-hit the API on every invocation and the code gives a false impression that failure caching exists.
## Pattern
Right:
```javascript
function readCache(path) {
  const cache = JSON.parse(readFileSync(path, "utf-8"));
  if (!isCacheValid(cache)) return null;
  return cache;
}

const cache = readCache(CACHE_FILE);
if (cache) {
  if (cache.error || cache.rateLimited) return null;
  return format(cache.data);
}
```

Wrong:
```javascript
function readCacheFile(path) {
  const cache = JSON.parse(readFileSync(path, "utf-8"));
  if (Date.now() - cache.ts > ttl) return null;
  return cache.data;
}

const cached = readCacheFile(CACHE_FILE);
if (cached) return format(cached);
// `null` now means both "negative cache hit" and "cache miss"
```
