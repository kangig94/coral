# A representation release retries every second, forever

**Status**: resolved. The incident remains recorded below; a regression test now reproduces the permanent
consumer failure and proves the terminal transfer.

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

Representation delivery now has two separate bounds in its public disposition: a 1,000 ms retry cadence
and a 60,000 ms settlement window. Exhausting the window does not claim that a consumer accepted the
release. It records `operator_exit_representation_release_retry_exhausted` in the durable operator
disposition store and transfers ownership to
`durable-representation-release-reconciliation`. The in-memory representation is released only after
that record is durable; if the store write is held, the existing store-repair successor retains the
slot and retries the write.

The regression test advances the full window against a permanently unavailable disappearance consumer,
asserts the exact attempt count, the distinct exhausted settlement, the durable refusal, and the absence
of a remaining representation-release hold.
