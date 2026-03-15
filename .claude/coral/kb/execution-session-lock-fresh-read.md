# Session Locks Need A Post-Lock Fresh Read
Promoted: 2026-03-15 | Updated: 2026-03-15
## Rule
If `SessionManager` moves from per-read `statSync` to a shared cache plus asynchronous invalidation, any mutation path that treats the session lock as its correctness boundary must force a fresh read or synchronous stamp revalidation after acquiring the lock. The lock only serializes writers; it does not retroactively make a stale cached session entry authoritative.
## Why
`claimForJobAtomic()` and similar paths decide ownership based on fields such as `activeJobId` and `version` immediately after the lock is held. If those reads still go through the normal cache-hit path, watcher lag can let a lock holder observe pre-lock state and make the wrong claim or release decision, even though the filesystem lock itself worked correctly.
## Pattern
Right:
```ts
async function claimForJobAtomic(sessionId: string, jobId: string, expectedVersion?: number) {
  const release = await acquireSessionLock(sessionId);
  try {
    const entry = readEntry(sessionId, { forceFresh: true });
    if (!entry || entry.activeJobId) return false;
    if (expectedVersion !== undefined && entry.version !== expectedVersion) return false;
    writeEntry({ ...entry, activeJobId: jobId });
    return true;
  } finally {
    release();
  }
}
```

Wrong:
```ts
async function claimForJobAtomic(sessionId: string, jobId: string) {
  const release = await acquireSessionLock(sessionId);
  try {
    const entry = readEntry(sessionId); // can still be a stale cache hit
    if (!entry || entry.activeJobId) return false;
    writeEntry({ ...entry, activeJobId: jobId });
    return true;
  } finally {
    release();
  }
}
```
