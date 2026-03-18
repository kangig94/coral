# Wait Stream Must Observe Terminal Status Fallbacks
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
If terminal persistence is split between a strict `progress.jsonl` append and a status-only fallback, `waitStream()` must treat terminal `status.json.phase` values as terminal outcomes too. Do not rely on replaying a terminal JSONL record as the only way to release waiters.
## Why
A terminal JSONL write can fail while the fallback still records the terminal phase in `status.json` and notifies waiters. If the wait loop only looks for terminal events in the stream, the notification wakes it up but nothing terminal is observable, so the job remains pending forever.
## Pattern
```ts
// Wrong: only terminal JSONL events can complete the wait.
const event = readNextEvent(jobId, cursor);
if (event?.type === 'terminal') return event;
return waitForMore();
```

```ts
// Right: synthesize completion from terminal status when the stream lacks it.
const event = readNextEvent(jobId, cursor);
if (event?.type === 'terminal') return event;

const status = readStatus(jobId);
if (status && isTerminalPhase(status.phase)) {
  return terminalFromStatus(status);
}

return waitForMore();
```
