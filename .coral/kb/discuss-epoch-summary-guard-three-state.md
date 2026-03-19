# Epoch Summary Guard: Three-State Sentinel

## Rule
`epoch_summary_written` uses a three-state sentinel (`0` / `null` / `N > 0`) to guard `applyEpochSummary` against calls that occur before any epoch transition. `0` = initial (no transition), `null` = transition occurred (summary due), `N` = summary written for epoch N. The guard `epoch_summary_written !== null` rejects both "no transition yet" and "already written" cases, since the only valid call window is when the value is exactly `null`.

## Why
The discuss-lead LLM may call `_5_epoch` at any time, even when no epoch transition has occurred. The previous guard (`epoch_summary_written === state.epoch`) only caught duplicate writes after a valid summary. With `null` as the initial value, the initial-state check `null === 1` was `false`, so the guard allowed the call through — corrupting `bid_release_step` and causing deadlocks where bidders received `speaker: 'moderator'` and the actual winner never learned it won.

## Pattern
```typescript
// WRONG — null initial value passes the equality guard
initSession: { epoch_summary_written: null }
guard: if (state.epoch_summary_written === state.epoch) reject; // null === 1 → false → allows!

// RIGHT — 0 initial value, null reserved for "transition occurred"
initSession: { epoch_summary_written: 0 }
guard: if (state.epoch_summary_written !== null) reject; // 0 !== null → true → rejects!

// State transitions:
// 0 → (initSession) no transition yet, reject summary
// null → (resolveWinner epoch transition) summary is due, allow
// N → (applyEpochSummary) summary written, reject duplicate
```
