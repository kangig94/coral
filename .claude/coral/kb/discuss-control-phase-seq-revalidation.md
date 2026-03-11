# Discuss Replay Needs Control Phases and Seq Revalidation
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
When discuss state becomes event-sourced, persist the next control action as part of the runtime projection and commit async results with seq revalidation. A replayable `DiscussState` is not enough: restart logic must know whether the next durable action is epoch evaluation, follow-up collection, or synthesis, and any provider result computed before an `await` must only append if the session still matches the expected `lastAppliedSeq`.
## Why
Two different failures appear if either half is missing. Without a persisted control phase, restart can load a valid snapshot and still resume the wrong branch, such as collecting new bids immediately after an epoch-closing `bid.round.closed` instead of running the evaluator first. Without seq revalidation, manual `discuss_participate` or another writer can advance the session while provider work is in flight, and the stale provider result then overwrites newer state from the wrong snapshot.
## Pattern
Right:
```ts
const base = store.load(sessionId);
const outcome = await runProviderTurn(buildPrompt(base.state));
const latest = store.load(sessionId);

if (latest.lastAppliedSeq !== base.lastAppliedSeq) {
  return redecideOrDrop(outcome, latest);
}

store.append(sessionId, latest.lastAppliedSeq, decideBid(latest.state, outcome));
// reducer also projects runtime.controlPhase = 'evaluate_epoch' | 'collect_follow_up' | 'synthesize'
```

Wrong:
```ts
const state = session.state;
const outcome = await runProviderTurn(buildPrompt(state));

session.state = applyBid(state, outcome);
// restart only sees DiscussState, so it falls back to the generic bidding branch
```
