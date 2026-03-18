# Statusline Fetch Lock Stampede Prevention
## Rule
When multiple Claude sessions share a single cache file, use a file-based exclusive lock (`writeFileSync` with `flag: "wx"`) to ensure only one process fetches from the API at a time. Lock-blocked processes serve previous cache data instead of fetching. Clean up stale locks (>10s) on every invocation.
## Why
Without a lock, N sessions with the same cache TTL all expire simultaneously, triggering N parallel API calls. The API returns 429 to N-1 of them, escalating exponential backoff (e.g., 5 sessions → `rateLimit: 4` → 16-minute wait). With a lock, only 1 session fetches while others use existing cache data.
## Pattern
Right:
```javascript
function acquireFetchLock(cachePath) {
  const lockPath = cachePath + ".lock";
  try {
    const raw = readFileSync(lockPath, "utf-8");
    const lockData = JSON.parse(raw);
    if (Date.now() - lockData.ts <= LOCK_STALE_MS) return null; // held
    try { unlinkSync(lockPath); } catch {} // stale, remove
  } catch {} // no lock file
  try {
    writeFileSync(lockPath, JSON.stringify({ ts: Date.now() }), { flag: "wx", mode: 0o600 });
    return lockPath; // acquired
  } catch {
    return null; // race lost
  }
}
```

Wrong:
```javascript
// No lock — all sessions fetch simultaneously on cache expiry
const cached = readCacheFile(CACHE_FILE);
if (!cached) resp = await fetchUsage(...); // N parallel calls
```
