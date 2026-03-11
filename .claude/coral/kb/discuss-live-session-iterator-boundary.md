# Discuss Live Session Iterator Must Not Double As Persisted Summary Listing
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
`DiscussManager.listSessions()` is part of the live-runtime contract and must stay scoped to attached live sessions. Persisted `/api/discuss` summaries need a separate store-backed summary surface; otherwise registry, idle-shutdown, and other runtime callers silently switch from "what is currently attached" to "what exists on disk."
## Why
The current backend mixes two different consumers: lifecycle code needs live runtime objects, while list endpoints need persisted summaries. Reusing one method for both looks convenient but breaks hidden assumptions in registry iteration and idle checks because those paths were never written to tolerate persisted-ended sessions.
## Pattern
Right:
```ts
manager.listSessions(); // live attached sessions only
store.listSummaries();  // persisted summaries for /api/discuss
```

Wrong:
```ts
manager.listSessions(); // now returns persisted rows too
idleTimerUses(manager.listSessions());
```
