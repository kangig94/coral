# Wait-For-All Loops Must Pass Cursors to Avoid Duplicate Progress

## Rule
When using `wait` in a wait-for-all loop (any-semantics: returns on first completion, caller loops with remaining sessions), each new `wait` call must pass the `cursors` returned by the prior call. Without cursors, each `wait` starts progress.jsonl tailing from byte offset 0, replaying all prior progress for still-running sessions as duplicate `notifications/progress` events.

## Why
`wait` uses any-semantics: it returns as soon as one session completes, leaving the rest running. The caller then calls `wait(remaining_sessions)` to wait for the next one. Without cursors, the new `wait` call re-reads each session's progress file from the beginning — causing duplicate progress notifications proportional to the number of wait-for-all rounds times the number of still-running sessions.

## Pattern
```
// FIRST wait call:
const r1 = codex({ op: "wait", sessions: [id1, id2, id3] })
// → { status: "completed", completed_session: id1, cursors: { id2: 1024, id3: 512 } }

// NEXT wait call — pass cursors to resume tailing:
const r2 = codex({ op: "wait", sessions: [id2, id3], cursors: r1.cursors })
// → { status: "completed", completed_session: id2, cursors: { id3: 1024 } }

// FINAL wait call:
const r3 = codex({ op: "wait", sessions: [id3], cursors: r2.cursors })
```

Omitting `cursors` causes each `wait` to re-read from byte 0 — linear duplicate notification growth.
