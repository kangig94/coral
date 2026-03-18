# discuss: bid_release_step Must Be Set With a Strictly Greater step

## Rule
Any state transition that sets `bid_release_step` must also increment `step` so that `bid_release_step < step`. The `bidReleased` condition checks `bid_release_step >= bidStep` — if `bid_release_step === step`, this is immediately true for any bid at the current step, releasing agents before the moderator resolves the winner.

## Why
`applyEpochSummary` once set `bid_release_step: state.step` without incrementing `step`. All agents were immediately released from their bids, the winner never knew they won (phantom winner → speech timeout), and all other agents stuck in a speaking wait loop indefinitely.

## Pattern
```typescript
// WRONG — bid_release_step == step triggers immediate release
return {
  ...state,
  bid_release_step: state.step,   // ← equal to step, condition fires at once
};

// RIGHT — step incremented so bid_release_step < new step
return {
  ...state,
  step: state.step + 1,           // ← increment first
  bid_release_step: state.step,   // ← now strictly less than new step
};
```

The invariant: after any write, `state.bid_release_step < state.step`. Enforced by the same pattern as `buildSpeechState` — always increment `step` alongside any `bid_release_step` assignment.
