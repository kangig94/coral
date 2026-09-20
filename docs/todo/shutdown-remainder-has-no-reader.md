# TODO — project held shutdown state through health

**Status**: open. Track B of kangig94/coral#357. The no-daemon reader shipped with the writer branch; this
entry retains only the live coordinator health-projection question.

## What exists

`recordShutdownRemainder` (`src/coordinator/shutdown-remainder.ts`) writes the run directory's single
`shutdown-remainder.v1.json` whenever a shutdown finalizes with losses: one entry per undischarged
obligation, keyed by the ledger's `label`, carrying a `remainder` and a `settlement` shaped by its `cause`
(the thrown error for `rejected`/`aborted`, `budgetMs` for `timed-out`, a free-text `detail` for
`unconfirmed`, nothing further for `budget-exhausted`), under a record that carries `instanceId`,
`recordedAt`, `reason`, and `mode`. `classifyShutdownRemainderFile`
(`src/infra/shutdown-remainder-record.ts`) decodes that one address tolerantly — per record and per entry,
skips counted. The no-daemon arm of `backend status`, `readRecentShutdownRemainder`
(`src/transport/http/backend/status.ts`), calls it and layers its own recency and instance scoping on top
of the record's own `recordedAt` and `instanceId`. It reads that record for the `no_record_no_socket`,
`no_record_socket_present`, and `recorded_process_absent` observations, scopes it to the same recent-record
window as the startup diagnostic, and reports it without a next step. `foreign_peer` itself never carries a remainder — its `unreachable` variant has no `shutdownRemainder` field
— but a foreign-peer call into `statusWithRecentCoordinatorEvidence` (`src/transport/http/backend/status.ts`) still reaches this
reader whenever a startup diagnostic exists: the diagnostic branch runs first and consults the record
unconditionally, superseding the foreign-peer fallback with its own `recent_failure`. Only when there is no
diagnostic does `statusWithRecentCoordinatorEvidence` return the foreign-peer fallback without consulting the record.

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
inspection verb. That entry is about handoff routing invocations and is untouched here; the remainder side
of the same question has no threshold to remove, because one address holds one record and there is no
retained history to render.
[`reproducible-fatal-successor-loop`](./reproducible-fatal-successor-loop.md) is observed through this
reader and should not be costed before it exists.

## A hold reached through the generic ledger fallback has no keepalive

`SettlementHold` (`src/obligation/settlement.ts`) declares `retryAfter?: Promise<void>` as optional, and
`SettlementLedger`'s `createHeldDisposition` falls back to a bare `this.options.time.sleep(this.options.pollMs)`
whenever a boundary's `hold()` omits it — the exact shape `keepaliveGuardedRetryAfter`
(`src/coordinator/shutdown.ts`) exists to guard against: `time.sleep` (`src/infra/time.ts`) unrefs its own
timer, so a hold reached through this fallback after the IPC listener and HTTP server have already closed
can leave nothing ref'd, and the process may exit before the fallback sleep ever resolves. Dead today:
`buildAuthorityReleaseBoundary` (`src/coordinator/shutdown.ts`) is the only production
`SettlementAuthorityReleaseBoundary`, and its `hold()` always supplies its own keepalive-guarded
`retryAfter`. Closing it means either wrapping the ledger's fallback sleep in the same keepalive or making
`retryAfter` required, so a future boundary cannot omit it silently.

## Widening the reason or mode vocabulary no longer makes a rolled-back build delete evidence — closed

`SHUTDOWN_REASONS` and `SHUTDOWN_MODES` (`src/infra/persisted-scalar-contracts.ts`) validate the `reason`
and `mode` fields of `shutdown-remainder.v1.json` through `z.enum` derived from those same arrays
(`src/infra/shutdown-remainder-record.ts`). A build that adds a reason or mode writes a record an older,
rolled-back build's narrower enum cannot parse. `classifyShutdownRemainderFile` now names that fact
`unsupported`, distinct from `corrupt` (bytes that are not JSON at all, decisive for every build): an
envelope shape rejection is decisive only about the build observing it, never about an older or newer one
that may still decode the same bytes (design-philosophy.md §10's rollback case). Nothing deletes on that
classification — `backend status` reports it with its cause and leaves the bytes where they are, so a
build that can decode them still finds them.

This entry previously recommended deriving `SHUTDOWN_REMAINDER_RECORD_VERSION` from
`SHUTDOWN_REASONS`/`SHUTDOWN_MODES` so a vocabulary change would land in a fresh generation. That
recommendation was wrong and was not applied: `SHUTDOWN_REMAINDER_RECORD_NAME` (derived from
`SHUTDOWN_REMAINDER_RECORD_VERSION`) is the only address any reader touches, so bumping the version on
every vocabulary change would orphan the record nothing would ever read again while the new generation
starts empty. A generation bump is the right tool for a shape that cannot stay additive
(design-philosophy.md §10); a closed-enum field that gains a member is exactly the additive case §10's
settled paragraph describes, and the disposition split above is what makes it fail softly without a new
address.
