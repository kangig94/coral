# Discuss Empty Event Log Persistence
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
`SessionStore.persistMutation()` should persist `state.json` and watermark metadata even for zero-event mutations, but it should only create `event-log.jsonl` when there is at least one machine event to append. Tests for synthesis-style mutations should assert that the event-log file is absent, not merely empty.
## Why
The discuss event log is append-only machine history, not a marker that every snapshot write produced structured machine events. Creating an empty log file for zero-event mutations would blur the boundary between “state changed without machine history” and “machine-history stream exists for this mutation batch.”
## Pattern
Right:
```ts
const eventLogPath = discussEventLogPath(sessionDir);
const { watermark } = prepareMutation(eventLogPath, 0);

store.persistMutation(sessionDir, state, [], watermark);

expect(existsSync(eventLogPath)).toBe(false);
```

Wrong:
```ts
store.persistMutation(sessionDir, state, [], watermark);

expect(readFileSync(eventLogPath, 'utf8')).toBe('');
// assumes the file should exist even when no machine events were emitted
```
