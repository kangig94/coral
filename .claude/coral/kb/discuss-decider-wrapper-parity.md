# Discuss Decider Migration Must Preserve the Legacy Creation Surface
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
During the event-sourced discuss migration, keep compatibility wrappers for `initSession()` and `startBidding()` in addition to the existing `apply*` wrappers, because the current execution layer still calls them directly. Parity checks for `session.created` must compare against the real legacy creation path (`initSession` -> stamp `state.session_id` -> `startBidding`) instead of raw `initSession()` output, since `initSession()` intentionally leaves `session_id` blank and `DiscussManager.start()` fills it in afterward.
## Why
The Phase 1 plan naturally focuses attention on `apply*` wrappers, but the untouched manager and tests still rely on pre-event creation helpers. Removing or changing those exports too early breaks the tree before later batches move callers onto store-backed appends. Separately, `session.created` already carries the canonical `sessionId`, so naive reducer-parity tests appear to fail even when the domain state is otherwise identical; the mismatch is only the old post-init session-id assignment.
## Pattern
Right:
```typescript
// Keep legacy helpers alive during the phased migration.
export function initSession(input: DiscussCreateInput, now: string): DiscussState {
  const events = decideSessionCreate(input, '', '', input.topic, 1, now);
  return reduceDiscussEvent(makeEmptySnapshot('', ''), events.value[0]).state;
}

// Parity test follows the legacy call path that production uses today.
const direct = unwrap(startBidding({ ...initSession(input, now), session_id: sessionId }, now));
const replayed = replayDiscussEvents(decideSessionCreate(input, sessionId, root, input.topic, 1, now));
expect(replayed.state).toEqual(direct);
```

Wrong:
```typescript
// Remove init/start wrappers immediately even though current callers still use them.
export { decideSessionCreate as initSession };

// Compare event replay against raw initSession output.
expect(replayed.state).toEqual(initSession(input, now)); // false mismatch on session_id
```
