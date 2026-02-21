# Monotonic Marker for Polling Signals

## Rule
When a polling waiter needs to detect a transient state transition (e.g., "speech was delivered"), model it as a monotonic counter/step-marker in persisted state rather than a boolean flag. A boolean flag can be set and reset within a single atomic state transition before any external reader polls, making the `true` state unobservable.

## Why
`speech_delivered: boolean` is written to `true` inside `applySpeech`, then immediately reset to `false` when the bidding phase starts — all in one atomic write. A polling waiter that checks `state.json` at any point only ever sees `false`. The condition can never be observed.

## Pattern
```typescript
// WRONG — transient boolean, may be unobservable by polling waiter
applySpeech(...) {
  return { ...state, speech_delivered: true, status: 'bidding' };
  // waiter reads state.json → sees speech_delivered=false (already bidding)
}

// RIGHT — monotonic step marker persisted permanently
applySpeech(state, ...) {
  const last_speech_step = state.step;  // capture before increment
  return { ...state, status: 'bidding', step: state.step + 1, last_speech_step };
}

// Polling predicate:
const speechDelivered = (s: DiscussState) =>
  s.status === 'bidding' && s.last_speech_step === s.step - 1;
// This remains true until the next bid round resets bids, giving the waiter
// a stable window of multiple poll intervals to observe the condition.
```

The predicate `last_speech_step === step - 1` is true from the moment `applySpeech` completes until the first `applyBid` of the next round — a stable window of seconds rather than microseconds.

## Extension: Step Increment as Epoch Boundary Enforcement Signal

The same monotonic `step` can serve dual duty as an enforcement watermark. When `transcript_read_step[agent]` tracks the `step` at which an agent last called `discuss({ op: "transcript", ... })`, incrementing `step` at any epoch boundary instantly invalidates all prior reads:

```typescript
// In resolveVote (non-unanimous vote → epoch transition):
const newState = resetBids({
  ...withVote, epoch: state.epoch + 1, cold_start: true, status: 'bidding',
  step: state.step + 1,  // ← increment creates gap: agent's readStep < new step
});

// In applyBid enforcement:
if (state.status === 'bidding' && state.last_speech_step > 0) {
  const readStep = state.transcript_read_step[agentName] ?? 0;
  if (readStep < state.step) return { ok: false, error: 'read_transcript_first' };
}
```

Agents who read during epoch 1 (setting `readStep = 3`) find their read stale at epoch 2 start (`step = 4`). No new field needed — `step` is already the authoritative monotonic counter.

Key insight: `speechDelivered` predicate (`last_speech_step === step - 1`) remains safe after this increment because `last_speech_step` was set during the previous epoch's last speech, NOT at `step - 1` after the increment.
