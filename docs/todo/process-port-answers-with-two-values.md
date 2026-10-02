# TODO — give the process port explicit uncertain outcomes

**Status**: partly implemented. The composition gate and exact live-child authority exist; three `ProcessPort` members still collapse dispositions.

`ProcessPort` in `src/runtime/ports.ts` returns `ProcessIncarnation | null` from `readProcessIncarnation`, although `null` can mean absence or an unreadable probe. Its `kill` returns a boolean that cannot distinguish `ESRCH`, `EPERM`, and other failures. Its `spawn` returns a child handle before a deferred `error` event can report launch failure. The batch identity observation already has an explicit `incarnation | pid-absent | unobservable` evidence union.

`tests/invariants/process-observation-composition.test.ts` guards the current migration boundary and keeps a self-pruning ledger. `LiveChildAuthority` in `src/infra/process-supervision.ts` ties own-child signal authority to collection state, and `gracefulKill` already returns `GracefulKillDisposition`. Those changes do not alter the three remaining port signatures.

Convert the three members to explicit result unions and migrate their callers. At the settlement boundary, `SettlementConfirmation` in `src/obligation/settlement.ts` also needs to distinguish observed alive from unobservable instead of putting both under `confirmed: false` with a reason string. Keep signal authorization separate from result classification: a tri-state numeric `kill` result cannot prove that the pid still names the recorded process at delivery time.

After callers move, remove the obsolete `kill-port-returned-false` reason and the bare-`safeKill` invariant half while preserving the signal-sequence check. The sibling `src/infra/process-*.ts` files also still meet the subdivision trigger for a `src/infra/process/` home.

## Start condition

Use the compiler and the invariant ledger to migrate one port member at a time. Preserve each caller's current refusal on uncertainty until it has a named successor.
