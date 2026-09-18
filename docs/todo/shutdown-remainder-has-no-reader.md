# TODO — project held shutdown state through health

**Status**: open. Track B of kangig94/coral#357. The no-daemon reader shipped with the writer branch; this
entry retains only the live coordinator health-projection question.

## What exists

`recordShutdownRemainder` (`src/coordinator/shutdown-remainder.ts`) writes
`shutdown-remainder.v1/<instanceId>.json` into the run directory whenever a shutdown finalizes with losses:
one entry per undischarged obligation,
keyed by the ledger's `label`, carrying a `remainder` and a `settlement` shaped by its `cause` (the thrown
error for `rejected`/`aborted`, `budgetMs` for `timed-out`, a free-text `detail` for `unconfirmed`, nothing
further for `budget-exhausted`), under a record that carries `instanceId`, `recordedAt`, `reason`, and
`mode`. `readShutdownRemainderStatus` in the same module decodes it tolerantly — per record and per entry,
skips counted. The no-daemon arm of `backend status` reads the newest record for the `no_record_no_socket`,
`no_record_socket_present`, and `recorded_process_absent` observations, scopes it to the same recent-record
window as the startup diagnostic, and reports it without a next step. `foreign_peer` never reaches this
reader: `noDaemonStatus` (`src/transport/http/backend/status.ts`) returns before consulting it whenever the
fallback status is `unreachable`, which is what a decoded peer identity mismatch always is.

## What is wrong

The remaining question is narrower. The lifecycle projects a held boundary's `reason` and `exit` into
`LifecycleShutdownRecovery` (`src/coordinator/lifecycle.ts`). There is no `transfer-pending` lifecycle arm:
`GateResolution` (`src/obligation/settlement.ts`) is only `held` or `terminal`. A boundary prepare or commit
refusal produces `held`; final boundary exhaustion or a successful commit produces `terminal`; remainder
acceptance is attempted only for that terminal outcome. The reader therefore needs to render the held
boundary reason and exit, not preserve a lifecycle distinction the code does not have.

## What closing it requires

- Carry the held boundary's `reason` and `exit` through the health projection without inventing a
  `transfer-pending` state.

**Interaction.** [`status-prints-history-it-should-not-carry`](./status-prints-history-it-should-not-carry.md)
argues that `backend status` should not carry history past a threshold and that history belongs on an
inspection verb; the no-daemon reader intentionally renders only the newest recent record, not retained
history.
[`reproducible-fatal-successor-loop`](./reproducible-fatal-successor-loop.md) is observed through this
reader and should not be costed before it exists.
