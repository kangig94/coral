# Reef Multi-Backend Canonical Sync
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
When reef aggregates more than one coral backend, do not treat live SSE as sufficient for canonical dashboard state and do not push source disambiguation into the frontend. Materialize each source into SQLite from an authoritative snapshot path, store `connectionId` plus the origin IDs on persisted rows, and keep the existing REST/UI contract by exposing stable reef IDs under the same field names. Local rows may keep their raw IDs for compatibility, but remote rows must be source-qualified to avoid collisions, and live WebSocket payloads must reuse those same reef IDs in existing `data.jobId` / `data.sessionId` fields instead of relying on top-level `source` alone.
## Why
The current reef UI reads REST-backed SQLite tables, not raw WebSocket payloads, and the existing SSE stream only carries partial job/session/discuss information. If remote connections are added without a canonical resync path, Sessions and Discuss stay incomplete; if source identity is kept only on WebSocket envelopes, different backends can collide on the same `jobId` or `sessionId`, and unchanged detail views will not refresh because the frontend compares `data.jobId` and `data.sessionId` directly against REST route IDs. Solving both problems inside the reef index preserves the current UI while making multi-backend state trustworthy.
## Pattern
Right:
```ts
function toReefId(connectionId: string, originId: string): string {
  return connectionId === 'local:auto' ? originId : `${connectionId}:${originId}`;
}

type JobRow = {
  jobId: string; // reef ID exposed to existing routes/UI
  connectionId: string;
  originJobId: string;
};

await syncSnapshot(connectionId);
applyBestEffortLiveInvalidation(connectionId, event);
relay({
  event: event.type,
  data: {
    ...event.data,
    jobId: toReefId(connectionId, event.data.jobId),
  },
  source: { id: connectionId },
});
if (streamIdChanged) {
  await syncSnapshot(connectionId);
}
```

Wrong:
```ts
broadcast({ event, data, source });
// raw origin IDs still live under data.jobId / data.sessionId
// no source-aware persistence
// no snapshot resync on reconnect
// sessions/discuss assumed to be recoverable from sparse live events
```
