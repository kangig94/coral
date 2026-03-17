# Snapshot Freshness Must Use External Signal
Promoted: 2026-03-18 | Updated: 2026-03-18
## Rule
When checking whether a persisted snapshot is stale relative to an append-only log, the freshness signal MUST come from outside the snapshot (e.g., `statSync` file size). Internal snapshot fields (like `lastAppliedSeq` or a `logTailSeq` written alongside the snapshot) are self-consistent after a successful write, so a stale snapshot from a crash between log-append and snapshot-write will pass any internal consistency check and silently mask lost events.
## Why
In `discuss-session-store.ts`, a proposed `logTailSeq` optimization would have stored the log's last seq inside the snapshot. After a crash between `appendEventBatch` and `writeAtomicJson`, the stale snapshot's `logTailSeq == lastAppliedSeq` would pass the guard, silently dropping events. Discovered during plan review (FRAME-level CRITICAL finding).
## Pattern
Right: `if (statSync(logPath).size === snapshot.logByteOffset) return snapshot;` — external filesystem signal that survives crash.

Wrong: `if (snapshot.lastAppliedSeq >= snapshot.logTailSeq) return snapshot;` — both values written atomically together, so a stale snapshot satisfies this trivially.
