# Discuss: Redact Sealed-Bid Internals from Live Debug APIs
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
If discuss state moves from disk snapshots to a manager-owned in-memory source of truth, any retained live debug/API surface must still return a redacted summary instead of raw `DiscussState`. `current_bids` and transcript bid tables remain sealed-bid internals even when they come from the manager rather than `state.json`; only audit artifacts should carry raw bid data.
## Why
It is easy to treat the migration from snapshot reads to manager reads as sufficient because the source of truth is now correct. That fixes authority, but not confidentiality: `DiscussState` itself still contains bid tables, so exposing it directly through `/api/discuss/detail` or similar surfaces silently breaks the sealed-bid contract while appearing architecturally "clean."
## Pattern
```ts
// Wrong: return raw live state from a debug endpoint.
sendJson(res, 200, { session: manager.getSession(sessionId)?.state });
```

```ts
// Right: return a manager-owned summary that excludes bid internals.
sendJson(res, 200, {
  session: {
    sessionId: state.session_id,
    topic: state.topic,
    status: state.status,
    epoch: state.epoch,
    step: state.step,
    currentSpeaker: state.current_speaker,
  },
});
```
