# Dashboard Live Stream vs Wait Contract
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
Do not treat a dashboard-wide SSE feed as equivalent to the per-job `wait/stream` contract unless every event class on that feed has durable replay semantics. If only job progress has a stable replay cursor, keep active chat/progress UX on `wait/stream`, define the global live feed as best-effort invalidation with a stream identity, and require a full rescan of canonical state after reconnect or backend restart. Persist authoritative `projectRoot` on session metadata instead of inferring it from `cwd` or shard hashes during that rescan.
## Why
The execution backend already has replay-safe job progress via per-job cursors, but session updates and discuss mutations are persisted differently and do not currently support the same restart-safe replay contract. Reusing one global SSE feed for both active chat and dashboard indexing makes reconnect behavior ambiguous: the client cannot distinguish safe replay from dropped or duplicated updates, and project discovery fails if session shards do not carry authoritative provenance. Splitting responsibilities keeps the interactive path reliable and makes dashboard resync explicit.
## Pattern
Right:
```text
Active chat progress -> /wait/stream
Dashboard live feed -> /events/stream { ready(streamId), change hints }
Reconnect/streamId change -> rescan jobs + sessions + discuss state, then resume live feed
Session discovery -> persisted projectRoot / shard metadata
```

Wrong:
```text
Active chat progress -> global /events/stream
Dashboard indexing -> trusts Last-Event-ID replay for non-durable session/discuss events
Project discovery -> guesses from cwd or reverses shard hash
```
