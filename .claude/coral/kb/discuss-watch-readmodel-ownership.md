# Discuss Watch Read Model Ownership
Promoted: 2026-03-11 | Updated: 2026-03-12
## Rule
`discuss_watch` must have a single authoritative read model. When moving to an in-memory `watchHistory` cache, define ownership explicitly: recovery owns the single `readSessionEvents()` scan and passes precomputed `watchHistory` + `abortEnded` into `attachSession()`. The `getWatchState()` polling path reads only from the cache — zero disk I/O. New in-process sessions start with `watchHistory: []` and rely on `afterCommit()` incremental append.
## Why
The original split-authority design had `getWatchState()` rebuild from disk on every poll while `afterCommit()` maintained `watchTail` only for subscriber fan-out (never read by polling). A cache migration that ignores this split can silently double-scan the event log (once in abort detection, once in hydration) while the "no disk reads during polling" regression test still passes — because it only measures post-attach behavior.
## Pattern
Right:
```ts
// recoverPersistedSessions() owns the single scan
const events = this.readSessionEvents(sessionId);
const abortEnded = this.isAbortEnded(events);      // no second read
const watchHistory = buildWatchEvents(events);       // reuse same events
this.attachSession(snapshot, watchHistory, abortEnded);

// attachSession preserves cache on refresh
private attachSession(snapshot, initialWatchHistory = [], abortEnded = false) {
  const existing = this.sessions.get(snapshot.sessionId);
  if (existing) {
    existing.snapshot = snapshot;   // preserve watchHistory
    existing.abortEnded = abortEnded;
    return existing;
  }
  // cold attach: use preloaded history
  const session = { snapshot, watchHistory: initialWatchHistory, abortEnded, ... };
  this.sessions.set(snapshot.sessionId, session);
  return session;
}
```

Wrong:
```ts
// Double scan: abort detection + hydration in attachSession
if (this.isAbortEnded(sessionId)) return;           // reads disk once
this.attachSession(snapshot);                        // reads disk again inside
```
