# Discuss Watch Cursor Contract
Promoted: 2026-03-12 | Updated: 2026-03-12
## Rule
Paginate `discuss_watch` at the `WatchEvent[]` projection boundary, not at the underlying discuss domain-event log boundary. The cursor should represent the current projected watch-event length or index, because `buildWatchEvents()` intentionally drops many domain events while preserving append-only watch ordering.
## Why
If the cursor tracks raw domain-event sequence numbers or timestamps, polling clients inherit abstractions the tool does not return and can no longer reason about incremental delivery from the visible payload alone. Projection-aware cursors stay aligned with the actual `discuss_watch` contract, preserve tested event ordering, and avoid leaking lower-level log details into callers that only consume `WatchEvent[]`.
## Pattern
Right:
```ts
const watchHistory = buildWatchEvents(domainEvents);
return {
  events: watchHistory.slice(cursor ?? 0),
  cursor: watchHistory.length,
};
```

Wrong:
```ts
const nextSeq = domainEvents.at(-1)?.seq ?? 0;
return {
  events: buildWatchEvents(domainEvents.filter((event) => event.seq > cursor)),
  cursor: nextSeq,
};
```
