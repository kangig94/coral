# Discuss: Sealed-Bid Design and Auto Epoch Transition

## Rule
The discuss state machine uses a sealed-bid design (bid scores never returned in any API response) and automatic epoch transition (no termination vote). Epoch transition fires only when `allExhausted` = every agent has `quota_remaining === 0 AND fallback_used === true`. Stamp `transcript_read_step[agent] = step + 1` for all agents at transition time to prevent forced re-read at epoch boundaries.

## Why
"Pools empty" ≠ "all exhausted": an agent with `quota_remaining=1` who bids below threshold is in neither pool, but is NOT exhausted. If you trigger epoch transition when pools are empty (instead of when allExhausted), agents with remaining quota are silently skipped. The termination vote was removed because LLMs see `quota_remaining=0` as a finality signal and vote 0 reflexively, causing premature termination even when they have unaddressed counterarguments.

## Pattern

```typescript
// WRONG: epoch transition when pools empty
if (primaryPool.length === 0 && fallbackPool.length === 0) {
  return epochTransition(); // misses agents with quota who bid low
}

// RIGHT: check every agent is truly exhausted
const allExhausted = Object.values(state.agents).every(
  (a) => a.quota_remaining === 0 && a.fallback_used,
);
if (!allExhausted) {
  return { no_winner: true, reason: 'all_blocked' }; // structural block, not exhaustion
}
// Only here: trigger epoch transition or max_epochs_reached

// Stamp readStep at transition — agents arrive in epoch 2 pre-cleared
const transcript_read_step: Record<string, number> = {};
for (const name of Object.keys(state.agents)) {
  transcript_read_step[name] = state.step + 1; // same value as new step
}
```

Information veil boundaries:
- `discuss({ op: "state", ... })`: returns `total_speaks` (count-up), never `quota_remaining` (count-down)
- `formatFull`: bid entries filtered to `> **Speaker: Name**` only — scores hidden
- `discuss({ op: "wait", condition: "action_needed", ... })`: returns `your_speaks`, never bid scores or quota
- Audit trail: full bid scores in `state.json` transcript + `transcript.md` for humans
