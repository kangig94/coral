# Discuss Observer Bid Asymmetry
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
Observer participation is intentionally split across three surfaces. `collectBids()` should attempt bids for every non-banned agent whose `current_bids[name]` is still `null`, including observers. Quorum is narrower: `pending_bidders` only tracks required agents, so observers never block resolution. Cold-start selection is narrower again: observers may win the cold-start floor, but only if they actually submitted a numeric bid.
## Why
Treating observers like required agents makes optional participants stall the round. Treating them like pure bystanders makes their bids irrelevant even when they participate. The subtle bug is in `coldStartPick()`: once observers are allowed into the candidate pool, a null-bid observer can win on the fairness sort unless the picker also filters to submitted numeric bids.
## Pattern
```typescript
// RIGHT: collect all bids, require quorum from required agents only,
// and only cold-start pick from agents who actually bid.
const bidders = Object.entries(state.current_bids).filter(
  ([name, score]) => score === null && !state.agents[name]?.banned,
);

for (const [name, agent] of Object.entries(state.agents)) {
  if (agent.banned) continue;
  current_bids[name] = null;
  if (agent.participation === 'required') {
    pending_bidders.push(name);
  }
}

const eligible = Object.entries(state.agents).filter(
  ([name, agent]) =>
    !agent.banned &&
    agent.quota_remaining > 0 &&
    typeof state.current_bids[name] === 'number',
);

// WRONG: drive collection from pending_bidders or let null-bid observers
// participate in cold-start winner selection.
```
