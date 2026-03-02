# Cold-Start Expulsion Bypass

## Rule
The `hold_count >= 2` expulsion mechanism in `stepBidding` (step.ts) is skipped during the first bidding round (epoch 1, step 1) via `isFirstRound` guard. This mirrors `applyExpel`'s `isRespawn` check. During cold start, agents are still spawning and cannot be expected to bid within one timeout cycle. The discuss-lead's orchestration protocol handles truly unresponsive agents at a higher level.

## Why
Without this bypass, agents spawned simultaneously with the session are expelled after just one `_3_step` timeout cycle (~30s). The `isRespawn` path in `applyExpel` sets their bids to 0 (soft expulsion), causing the round to resolve with artificial 0-score bids — the single agent that bid in time wins trivially against four 0s.

## Pattern
**Right**: Skip hold_count expulsion entirely during first round. Let agents connect at their own pace.
```typescript
const isFirstRound = next.epoch === 1 && next.step === 1;
if (!isFirstRound && next.hold_count >= 2 && next.pending_bidders.length > 0) {
```

**Wrong**: Apply the same `hold_count >= 2` threshold to cold start and later rounds.

**Testing edge case**: When testing the `expelled` response path, at least one eligible agent must remain after expulsion. If ALL required agents are expelled, `noEligibleParticipants` triggers the `ended` path instead. Set one agent's bid to a value (removing it from `pending_bidders`) before triggering expulsion on the remaining agent.
