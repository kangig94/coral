# TODO — classify provider-operation terminalization at its existing catch

**Status**: open, filed on 2026-09-21. The disposition is derivable, but changing it is not part of the
representation-release retry withdrawal.

`terminalizeProviderOperation` has one catch around the transactional terminal composition. It currently
rethrows `ProviderOperationJournalError` and wraps every other throw in
`ProviderOperationAtomicTerminalizationError`; the recovery dispatcher then classifies that wrapper as
`retry-safe-unknown`. The catch can already distinguish the three answers the caller needs:

1. `ProviderOperationJournalError` means the provider-operation journal is corrupt. Keep the existing corrupt
   classification unchanged.
2. An error object with `'errcode' in error` is the store refusing the transaction. Preserve that object as the
   store-refusal answer. The repository already uses the same observable SQLite field in `src/store/epoch.ts`,
   and `HandoffRoutingStoreUnreadableError` in
   `src/store/handoff-routing-status-store/transaction.ts` deliberately carries `errcode` on the error object.
3. Anything else thrown from the closure means this build composed a terminal that its own synchronous
   validators refuse. That is a deterministic composition failure, not store availability.

`withImmediate` needs no change to expose the store-refusal member. It executes `BEGIN IMMEDIATE` before its
`try`, so a lock refusal at transaction entry already escapes as the store's original error object. The earlier
refusal of this split was right that “decisive” does not imply “deterministic” — `SQLITE_BUSY` is decisive and
transient — but wrong that the distinguishing fact was unobservable. `errcode` is observable before the catch
wraps it away.

The deterministic member is reachable today. `validateJobTerminalOrder` throws
`job_terminal_order_violation` for any job event appended after a terminal. A failed directive in
`terminalizeProviderOperation` appends `job.progress.emitted` and then `job.terminal.recorded`, so a job already
terminalized by another path rejects the first append synchronously.

Its disposition is also already named by the provider-operation record: `local-recovery-pending`.
`#consumeContainmentDisappearance` uses that phase for never-started work when exact containment is gone, and
`#driveLocalRecovery` drives it through job recovery and then deletes the provider-operation row. A future
classification change should route the deterministic composition member to that successor, keep journal
corruption corrupt, and keep store refusal distinct. It should not add a `withImmediate` stage protocol or
change the `ready` latch as part of that work.
