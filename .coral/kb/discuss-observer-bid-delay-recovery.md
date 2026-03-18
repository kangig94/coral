# Discuss Recovery Must Define Observer Bid-Delay Semantics
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
When discuss uses `min_bid_delay_ms` to hold the round open for observer bids, persist enough timing state to resume that wait deterministically after restart, or explicitly define that restart resets the delay window. Do not leave observer-delay behavior implicit inside the generic `idle` loop.
## Why
The live loop waits before resolving a winner when required bids are in but observer bids are still pending. If restart does not preserve or explicitly reset that window, recovery can either skip the observer chance entirely or apply the full delay a second time. Both outcomes change turn-taking semantics in a way that is hard to notice from the final transcript.
## Pattern
Right:
```ts
type PersistedDiscussRuntime = {
  controlPhase: 'idle' | 'observer_wait' | 'evaluate_epoch' | 'collect_follow_up' | 'synthesize';
  observerWaitStartedAt?: number;
};

if (runtime.controlPhase === 'observer_wait') {
  await waitRemaining(runtime.observerWaitStartedAt, state.min_bid_delay_ms);
}
```

Wrong:
```ts
if (runtime.controlPhase === 'idle') {
  resumeGenericLoop();
}
// restart no longer knows whether an observer window was open or how much time remained
```
