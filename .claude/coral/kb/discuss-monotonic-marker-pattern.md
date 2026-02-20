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
