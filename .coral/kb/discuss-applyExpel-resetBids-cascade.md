# applyExpel Non-Respawn Preserves Submitted Bids
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
In the non-respawn path of `applyExpel` (`state-machine.ts`), do not call `resetBids()`. Expel handling should only ban the missing required agents, remove them from `pending_bidders`, and clear `pending_since_ts`. Already-submitted bids and thoughts from healthy agents must remain intact, and `bid_release_step` must stay unchanged. The respawn path is the exception: it still fills zero-bids for pending agents in epoch 1 step 1.
## Why
`resetBids()` rebuilds the whole bidding round for a fresh cycle. If it runs during a partial non-respawn expel, healthy agents lose their submitted bids while the release step still reflects the original round. That mismatch strands waiters behind an unobservable release condition and can cascade into more expulsions.
## Pattern
```ts
// Right: preserve the current round and only remove expelled agents.
if (removedPendingBidders.size > 0) {
  nextState = {
    ...nextState,
    pending_bidders: nextState.pending_bidders.filter(
      (name) => !removedPendingBidders.has(name),
    ),
  };
}
```

```ts
// Wrong: reset the whole round after a partial expel.
if (!isRespawn) {
  nextState = resetBids(nextState);
}
```
