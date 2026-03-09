# Discuss Resync Needs Snapshot-History Split and Buffered Stream Handoff
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
For restart-safe discuss syncing, do not force one file to serve both current snapshot and structured history. Keep `state.json` authoritative for the current session snapshot, keep the append-only discuss event log authoritative for structured machine-history, and make the snapshot/log handoff detectable: if the write path persists `state.json` before appending machine events, persist SessionStore-owned watermark metadata (for example a durable high-water mark plus pending seq range) so cold-scan/reconnect can fail closed or repair instead of silently trusting a snapshot that is ahead of the log. On reconnect attach the new live stream first, buffer incoming events, rescan `state.json` plus per-session event-log watermarks, then apply only buffered events newer than the scanned cursors before switching back to live processing.
## Why
`state.json` cannot reconstruct mutation-time semantics such as timeout-vs-authored speech, respawn-vs-ban expulsion, or canonical end reasons after the session has advanced. But a pure “rescan state, then reattach live” flow still leaves a loss/duplication window for events that land during the scan or between scan completion and SSE reattachment, and a naive “write state, then append log” path adds a second bug: crash after the state write leaves the snapshot ahead of history with no visible marker. Splitting snapshot from history, buffering the new stream, and persisting a detectable handoff watermark closes both gaps without pretending the global dashboard SSE feed has replay guarantees like `wait/stream`.
## Pattern
Right:
```text
Reconnect detected
-> open new /events/stream and buffer live discuss events
-> read snapshot/log handoff metadata; fail closed or repair if snapshot claims seqs the log does not contain
-> rescan discuss state.json + event-log max seq per session
-> upsert snapshot state from state.json
-> ingest structured history from event log
-> apply only buffered events with seq > scanned watermark
-> resume normal live handling
```

Wrong:
```text
Reconnect detected
-> rescan state.json only
-> ignore that the state write may have happened without the matching log append
-> reconnect live stream afterwards
-> infer timeout/expel/end semantics from final snapshot
```
