# A representation release retries every second, forever

**Status**: open. Observed in the wild on a developer machine, 2026-09-18, not reproduced from a test.

## What was seen

`~/.coral/gen2/run/coordinator.log.1`, a 10 MB rotated log, contained 72,641 copies of

```
WARN Provider proxy lifecycle containment-retry woke 1ms after its requested time.
```

out of 82,688 lines — 88% of the file. The first is stamped `2026-09-17T05:20:11Z` and the last
`2026-09-18T10:00:16Z`: **one retry per second for over 28 hours**, in a single coordinator instance,
ending only because the process died.

## Why it does not stop

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

## What a fix has to decide

The loop is cheap per iteration, which is why it survived — the cost is a log that reached 10 MB and an
obligation that never settles, not CPU. So the question is not the interval but the terminus: what a
representation release means when its consumer never comes back, and which of principle 11's two
remaining exits it takes. Note that `#recordLateness` is already called on every iteration, so the
lateness telemetry this produced is also 72,641 samples of nothing.

Worth checking while there: the same file has `acquisition-publication-retry` and
`containment-attempt-deadline` stages feeding `#recordLateness`, and whether either has the same shape.
