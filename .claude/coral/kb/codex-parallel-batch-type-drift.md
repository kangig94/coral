# Parallel Codex Batch Cross-Worker Type Drift
Promoted: 2026-03-09
## Rule
When running parallel Codex workers that modify shared types or behavior, each worker validates against its launch-time snapshot. The combined result can have type errors or test failures invisible to any individual worker. Always run full `tsc --noEmit` and `vitest run` after each batch completes — per-worker verification is necessary but not sufficient.
## Why
Three concrete drift patterns observed: (1) Private property cast — one worker added `as { field }` but another changed the field to private, requiring `as unknown as { field }`. (2) Type narrowing — one worker changed `pending_since_ts` from string to `number | null` while another's test used the old string type. (3) Behavior conflict — one worker added a corruption threshold that changed the contract a pre-existing test relied on (permanent corruption now errors instead of timing out with lastKnownGood).
## Pattern
```
# Right: verify combined state after each batch
Batch N workers complete → tsc --noEmit → vitest run → fix drift → next batch

# Wrong: trust per-worker tsc/test results as final
Worker A passes tsc ✓  Worker B passes tsc ✓  Combined: tsc ✗
```
