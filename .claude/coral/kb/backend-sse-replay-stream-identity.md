# Backend SSE Replay Needs Stable Stream Identity
## Rule
Persisting a monotonic `eventId` is not sufficient for SSE replay across daemon restarts unless the replay cursor is scoped to a stable stream identity. `Last-Event-ID` must be interpreted against a persisted per-job stream, or against a tuple that includes a restart epoch, not against a counter that can be regenerated after process restart. When one SSE connection multiplexes multiple job streams, the replay cursor must become a serialized map keyed by job id rather than a single scalar counter. When that cursor is parsed from the request, treat it as immutable input and update a cloned accumulator for outbound SSE `id` values instead of mutating the same object passed into replay.
## Why
If the daemon restarts and the event counter resets or the event log is rebuilt, the bridge cannot tell whether `Last-Event-ID: 17` means "resume after the 17th event in this same job stream" or "resume after a stale pre-restart counter value". That ambiguity causes duplicate delivery, skipped events, or terminal replay failures exactly in the reconnect/restart path the SSE design is supposed to harden.
## Pattern
```typescript
// Wrong: process-local monotonic counter with restart ambiguity
let nextEventId = 1;
append({ eventId: nextEventId++, ...event });
replayFrom(lastEventId);
```

```typescript
// Right: replay cursor scoped to stable job stream
type PersistedProgressEvent = {
  jobId: string;
  eventId: number; // monotonic within this job's log
  type: 'progress' | 'terminal';
  payload: unknown;
};

append(jobId, { eventId: previousEventId + 1, ...event });
replay(jobId, lastEventId);
```

```typescript
// Right for multiplexed wait: opaque cursor map serialized into Last-Event-ID
type WaitCursor = { jobs: Record<string, number> };

function encodeCursor(cursor: WaitCursor): string {
  return JSON.stringify(cursor);
}

function decodeCursor(header: string | undefined): WaitCursor {
  return header ? JSON.parse(header) as WaitCursor : { jobs: {} };
}
```

```typescript
// Wrong: outbound cursor updates mutate the replay input object
const cursor = decodeCursor(lastEventId);
await waitStream({ jobIds, cursor });
cursor.jobs[jobId] = eventId;
```

```typescript
// Right: keep replay input immutable, advance a separate SSE cursor
const inputCursor = decodeCursor(lastEventId);
const sseCursor = { jobs: { ...inputCursor.jobs } };
await waitStream({ jobIds, cursor: inputCursor });
sseCursor.jobs[jobId] = eventId;
```

```typescript
// Also acceptable: explicit restart epoch in the cursor contract
type ReplayCursor = { jobId: string; restartEpoch: string; eventId: number };
```
