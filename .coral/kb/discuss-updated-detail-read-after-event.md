# Discuss Detail Must Observe The Emitted `discuss:updated` Snapshot
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
If `discuss:updated` is the live-refresh trigger for discuss detail, the follow-up detail read must observe the committed snapshot identified by the event's `lastSeq`. Emitting the event after a store commit is not enough when HTTP detail can still read a stale live cache; either serve detail from the committed store snapshot or gate the read on the emitted sequence.
## Why
Without an explicit read-after-event contract, reef can receive a real discuss invalidation, refetch immediately, and still miss the just-committed batch. That makes live refresh flaky in a way that only appears during normal session updates, not on cold load or reconnect.
## Pattern
Right:
```ts
const committed = store.load(sessionId);
writeSseEvent(res, 'discuss:updated', { sessionId, lastSeq: committed.lastAppliedSeq });

app.get('/api/discuss/detail', () => buildDiscussDetail(store.load(sessionId), view));
```

Wrong:
```ts
store.append(sessionId, batch);
writeSseEvent(res, 'discuss:updated', { sessionId, lastSeq });

app.get('/api/discuss/detail', () => buildDiscussDetail(manager.getSession(sessionId).snapshot, view));
// the live cache can lag the committed store snapshot
```
