# A representation release retries every second, forever

**Status**: narrowed, not closed. The unbounded loop is gone and the incident remains recorded below. What
survives is the classification behind it: a deterministic terminalization failure is still retried as if it were
transient, now for 60 seconds rather than forever. See *What this does not settle*.

## What was seen

`~/.coral/gen2/run/coordinator.log.1`, a 10 MB rotated log, contained 72,641 copies of

```
WARN Provider proxy lifecycle containment-retry woke 1ms after its requested time.
```

out of 82,688 lines — 88% of the file. The first is stamped `2026-09-17T05:20:11Z` and the last
`2026-09-18T10:00:16Z`: **one retry per second for over 28 hours**, ending only because the process died.

It also survives restart. After a full teardown — coordinator shut down gracefully, guardian, reaper and
proxy killed, socket and discovery record gone — a cold boot logged `Running on 127.0.0.1:<port>` and the
first `containment-retry` line **one second later**. The loop is therefore rebuilt from durable
provider-proxy set state on every boot, not held in memory by one unlucky instance, which is why 28 hours
of it spanned more than one coordinator.

## Why it did not stop

`#scheduleRepresentationReleaseRetry` (`ProviderProxySetLifecycle`,
`src/coordinator/services/provider-proxy-set/index.ts`) schedules a fixed 1,000 ms timer that calls
`#deliverRepresentationRelease` and, on another unavailable-consumer outcome, schedules itself again.
There is no attempt counter anywhere on that path — `deliveryRetryTimers` holds one timer per operation
key and nothing counts how many times a key has been rescheduled. Its only non-success exits are
`slot.fatalSettlement !== null` and slot teardown, so a consumer that is permanently unavailable —
`representation_abandonment_consumer_unavailable` — produces an unbounded loop.

Principle 11 of [`design-philosophy`](../../.claude/rules/design-philosophy.md): *"a bounded retry is not
by itself an exit — exhausting it must reach a named successor, not the same hold."* This one is not even
bounded, so there is nothing to exhaust. Principle 12 is what makes it matter: nobody is watching, so
nothing was going to notice 28 hours of it.

## Resolution

Representation delivery keeps its 1,000 ms retry cadence, and the 60,000 ms settlement window is now armed once
against the slot when release begins rather than recomputed from each delivery outcome. The earlier shape
consulted the window only after a delivery failed or a retry timer woke, so a delivery that never settled at all
never reached it; the deadline now expires either way.

Expiry releases the **slot**, which is capacity rather than an obligation: `#removeRepresentationSlot` frees a
`MAX_COORDINATOR_PROXY_SET_SLOTS` slot, the mutation fence, the route, and the in-memory operator dispositions,
and the hold settles as `released-undischarged` — a variant of the settlement type, not a success carrying a
field. It names what survives (the provider-operation record the consumer never deleted) and who re-drives it
(`coordinator-startup-set-recovery`: the claim mirror is rebuilt from surviving records, `initializeClaimSlots`
gives each one a recovering slot, and startup set recovery drives `containmentAbsent` against that slot).

Nothing durable is written at expiry. The earlier resolution wrote
`operator_exit_representation_release_retry_exhausted` into the durable operator-disposition store and named
`durable-representation-release-reconciliation` as the successor. Both were wrong: that row is written as
`current-writer`, and the reconciler and its scheduler select only `stale` and non-canonical `successor-observed`
rows, so the writing process never reconciles its own row; and the successor that *would* eventually read it,
`#retireDurableSetDispositionsAfterContainmentAbsence`, retires the **row** and never terminalizes the
**operation**. The CLI's "no command is required: durable representation-release reconciliation owns the
remainder" was therefore false. The row, the refusal ground, the durable-write retry, and that CLI line are gone.

## What this does not settle

`ProviderOperationTerminalizationUnavailableError` was never constructed anywhere in `src/`, so the only route
into `disappearance_consumer_unavailable` is `ProviderOperationAtomicTerminalizationError`, which wraps every
non-journal throw from inside the synchronous `store.commit` closure and is classified `retry-safe-unknown`. The
dead error has been deleted, but the classification is unchanged: a deterministic throw — a schema rejection of
the terminal payload, a bad ref — is still retried at 1 Hz, now for 60 seconds instead of forever.

Splitting that classification needs a fact `terminalizeProviderOperation` cannot observe. `withImmediate`
(`src/store/db.ts`) runs `BEGIN IMMEDIATE`, the closure, then `COMMIT`, and rolls back on any throw; from outside
the `try` there is no way to tell a closure throw (decisive: nothing was written) from a `COMMIT` throw
(indeterminate). Tagging it means changing `withImmediate` or `commit`. And "decisive rollback" is not the same
as "deterministic": `SQLITE_BUSY` after the configured `busy_timeout` is decisive *and* transient, so treating
every decisive rollback as a non-retryable refusal would make ordinary lock contention a fatal representation
release. Both ends of that trade-off are defects, which is the signature of an axis
(see [`review-loop-dynamics`](../review-loop-dynamics.md)); it needs a construction where the store reports which
stage failed, not a choice between the two ends.
