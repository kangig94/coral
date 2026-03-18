# Discuss Abort-Ended Reason Not Force
Promoted: 2026-03-12 | Updated: 2026-03-12
## Rule
Cache `abortEnded` from the last `session.ended` event by checking `event.payload.reason === 'abort'`, not by checking `event.payload.force === true`. In discuss, `force: true` is also used for successful convergence paths that still need synthesis, so the cache must represent abort-specific semantics.
## Why
If `abortEnded` is derived from `force`, recovery and synthesis gates treat converged sessions as aborted. That suppresses the final synthesis after follow-ups and skips legitimate recovery for non-abort terminal sessions, even though the state machine intentionally ends them forcefully before synthesizing.
## Pattern
```ts
function isAbortEnded(events: DiscussDomainEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind !== 'session.ended') {
      continue;
    }
    return event.payload.reason === 'abort';
  }
  return false;
}
```

```ts
// Wrong: also matches converged sessions ended with force=true
return event.payload.force === true;
```
