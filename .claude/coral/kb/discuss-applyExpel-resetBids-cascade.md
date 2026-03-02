# applyExpel resetBids Cascade Bug (Known, Unfixed)

## Rule
In the non-respawn path of `applyExpel` (`state-machine.ts`), `resetBids` is called after banning agents. This wipes already-submitted bids from non-banned agents and re-adds them to `pending_bidders`, but does NOT update `bid_release_step`. Those agents are stuck in `waitForCondition(bidReleased(name, bidStep))` because their predicate never becomes true. On the next `hold_count >= 2` check, these trapped agents get expelled too, cascading to session termination.

## Why
Without this knowledge, debugging a "all agents expelled" session failure will lead to chasing the wrong root cause (e.g., agents being slow, hook failures) instead of recognizing the `resetBids` cascade as the structural issue.

## Pattern
**Current (buggy)**: `applyExpel` non-respawn path calls `resetBids(nextState)` at line 548, wiping bids from agents that already submitted them.

**Fix direction**: Remove `resetBids` from the non-respawn `applyExpel` path. Banned agents are already excluded by `collectSubmittedBids` and removed from `pending_bidders`. Remaining agents' bids should be preserved. Alternatively, update `bid_release_step` after `resetBids` to unblock waiting agents.
