# Session Index Events Need Invalidate-And-Reread Or Full Rows
Promoted: 2026-03-15 | Updated: 2026-03-15
## Rule
If `/api/sessions` preserves a lenient reporting contract such as grouped `LenientSessionEntry` rows but `session:updated` only emits identity/version metadata, treat the event as an invalidation hint and reread the canonical row from shared storage. Do not guess row fields from the event payload, and do not relax strict `SessionManager` runtime reads just to feed the reporting index.
## Why
The minimal `session:updated` payload does not carry `state`, `activeJobId`, `lastJobId`, `conversationRef`, `lastUsedAt`, or `provenanceState`. A plan that says "event-driven row upsert" without a reread path forces implementers either to fabricate stale/incomplete rows or to widen runtime parsers meant for strict operational use.
## Pattern
Right:
```ts
eventBus.on('session:updated', ({ shardHash, sessionId }) => {
  sessionIndex.invalidate(shardHash, sessionId);
  sessionIndex.upsert(shardHash, sessionId, readSessionEntryLenient(shardHash, sessionId));
});
```

Wrong:
```ts
eventBus.on('session:updated', (payload) => {
  sessionIndex.upsert(payload.shardHash, payload.sessionId, {
    sessionId: payload.sessionId,
    version: payload.version,
    // missing activeJobId/state/provenance; row is now a guess
  });
});
```
