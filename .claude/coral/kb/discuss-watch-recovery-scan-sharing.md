# Discuss Watch Recovery Scan Sharing
Promoted: 2026-03-12 | Updated: 2026-03-12
## Rule
If `discuss_watch` hydration moves to an in-memory `watchHistory` cache, the recovery path must share the same event-log read between abort detection and watch-history hydration. A plan that hydrates `watchHistory` in `attachSession()` but leaves `recoverPersistedSessions()` calling `isAbortEnded()` first still performs two full scans before the first poll.
## Why
The watch cursor change is meant to eliminate repeated disk reads and front-load recovery cost into a single cold-attach scan. The current recovery path already scans the event log through `isAbortEnded()`. Adding a second `readSessionEvents()` call in `attachSession()` silently violates the efficiency goal while the usual “poll twice after attach” regression test still passes, because it resets the spy after hydration and never measures the recovery attach path itself.
## Pattern
Right:
```ts
const events = this.readSessionEvents(sessionId);
if (abortEnded(events)) return;
const watchHistory = buildWatchEvents(events);
attachSession(snapshot, watchHistory);
```

Wrong:
```ts
if (this.isAbortEnded(sessionId)) return; // reads disk once
attachSession(snapshot); // attachSession reads disk again to build watchHistory
```
