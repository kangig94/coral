# Discuss Compound Event Batch: Determine Count Before prepareMutation

Promoted: 2026-03-10 | Updated: 2026-03-10

## Rule
When a single logical operation may emit either 1 or N events depending on a runtime condition (e.g. expel-then-end vs. end-only), determine `eventCount` before calling `prepareMutation()`. Then construct events using `nextSeq`, `nextSeq + 1`, etc. All events in the batch are written in one `persistMutation()` call so the seq range is atomically reserved and no partial batch can land.

## Why
`prepareMutation()` reads the event log once and returns `{ nextSeq, watermark }`. Calling it a second time for the second event would re-read the log, producing a stale `nextSeq` if another writer ran between the two calls. Determining count first and passing it to `prepareMutation()` is the only way to atomically reserve a contiguous seq range.

## Pattern
Right:
```typescript
function endNoParticipants(
  state: DiscussState,
  sessionDir: string,
  now: string,
  store: SessionStore,
  expelledAgents?: string[],  // present → compound batch (2 events)
): Result<BiddingPre> {
  const eventLogPath = discussEventLogPath(sessionDir);
  const eventCount = expelledAgents ? 2 : 1;
  const { nextSeq, watermark } = prepareMutation(eventLogPath, eventCount);

  const events: DiscussMachineEvent[] = [];
  if (expelledAgents) {
    events.push({ seq: nextSeq, kind: 'agents_expelled', ... });
  }
  events.push({ seq: expelledAgents ? nextSeq + 1 : nextSeq, kind: 'session_ended', ... });

  store.persistMutation(sessionDir, state, events, watermark);
}
```

Wrong:
```typescript
// Two separate prepareMutation calls — second call may get wrong nextSeq
const { nextSeq: seq1, watermark: wm1 } = prepareMutation(eventLogPath, 1);
store.persistMutation(sessionDir, state1, [{ seq: seq1, kind: 'agents_expelled', ... }], wm1);

const { nextSeq: seq2, watermark: wm2 } = prepareMutation(eventLogPath, 1);
store.persistMutation(sessionDir, state2, [{ seq: seq2, kind: 'session_ended', ... }], wm2);
// Two separate persists = non-atomic; second persist overwrites state from first
```
