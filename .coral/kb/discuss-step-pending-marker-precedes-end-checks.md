# Step Bidding Initializes Pending Marker Before End Checks
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
In `stepBidding`, build the next bidding snapshot before the `noEligibleParticipants` and expel branches, and treat any ended state that comes out of those branches as inheriting that pre-branch snapshot. With `pending_since_ts`, that means an ended state can legitimately carry a non-null pending marker even if no bid-wait cycle completed.
## Why
It is easy to assume the pending marker only changes when `_3_step` successfully enters a waiting window, but the handler mutates bidding state first and only then checks the early-end branches. Tests or follow-up changes that expect `pending_since_ts` to stay `null` on those endings will misread the real control flow and fail for the wrong reason.
## Pattern
```ts
// Right: next snapshot is constructed once, then reused by all exit paths.
const next = {
  ...current,
  pending_since_ts: current.pending_since_ts ?? Date.now(),
};

if (noEligibleParticipants(current)) {
  return endNoParticipants(next, sessionDir, nowIsoString(), store);
}
```

```ts
// Wrong: assume the marker is only meaningful after the wait path and
// assert null in ended-state tests that exit before waiting.
expect(savedState.pending_since_ts).toBeNull();
```
