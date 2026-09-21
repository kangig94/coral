# A representation release retries every second, forever

**Status**: the live re-attempt is withdrawn. The slot still has the 60-second settlement bound added by
`28115ec6`; after that bound, a failed disappearance delivery parks on the surviving provider-operation record
until this coordinator retires and startup re-observes containment absence. Abandonment does not have that
durable exit and remains the separate design problem recorded in
[`representation-release-notice-as-a-durable-phase`](./representation-release-notice-as-a-durable-phase.md).

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

The incident began at `2026-09-17T05:20:11Z`. This branch's first commit, `4a092867`, was authored at
`2026-09-17T10:59:16Z`, 5 hours 39 minutes later (about 5.5 hours; its committer timestamp is later). That
commit changed `provider-proxy-lifecycle-fatal` from hard shutdown to handoff. The timing is consistent with
the branch removing the incident's producer before later rounds designed a consumer-side re-attempt for it.

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

Representation delivery keeps its 1,000 ms retry cadence only while the representation slot exists. The
60,000 ms settlement window remains armed once against the slot when release begins rather than recomputed
from each delivery outcome. The earlier shape consulted the window only after a delivery failed or a retry
timer woke, so a delivery that never settled at all never reached it; the deadline now expires either way.

Expiry releases the **slot**, which is capacity rather than an obligation: `#removeRepresentationSlot` frees a
`MAX_COORDINATOR_PROXY_SET_SLOTS` slot, the mutation fence, the route, and the in-memory operator dispositions,
and the hold settles as `released-undischarged` — a variant of the settlement type, not a success carrying a
field. Its one `witness` field is derived from what is still outstanding at the bound: the provider-operation
record while an operation is pending, the handoff capsule when none is.

After the slot bound, `ProviderOperationReconciler.reconcile` returns immediately for a latched `ready`
disappearance or abandonment, matching `origin/main`. The `#reattemptLatchedRelease` helper and the fatal
observer that existed only for that helper are gone. Failed release deliveries still do not write the
provider-operation record: the slot's `operational-retry-owned` initial disposition already reports entry into
the failing state, and a second accounting write would create a second failure path and pair retry counters
with unrelated evidence.

The park has a named exit for **disappearance**. `#terminalizeDisappearance` calls
`#settleBindingOrThrow` and `#releaseStartupAndRetireBindingOrThrow` before it starts the dispatcher turn, so
the first attempt releases its startup permit and provider-operation binding even when terminalization returns
an operational failure. The serializer's delivery returns to `ready`, but its `inFlight` is `null`; a parked
record creates no request and retains no recovery-registry entry or adopted PID. If no other active work
exists, the coordinator idle predicate can therefore retire the process within its configured bound. The next
mutating command goes through `ensure`, which starts a successor when no coordinator serves the address.

That successor re-derives the observation from durable facts:
`reconcileAtStartup` groups the surviving record, `recoverSetAtStartup` invokes
`recoverProviderProxySetAtStartup`, `inheritProviderProxySet` returns `containment-disappeared` when recorded
containment is absent, composition calls `containmentAbsent`, and the lifecycle dispatches the same
`disappearance-consumer`. Restart does not remember an in-memory notice; it asks the world again and obtains a
new disappearance observation.

The same is not true for **abandonment**. Its terminal directive is constructed only inside
`#consumeRepresentationAbandonment`, the latch is memory-only, and neither the provider-operation record nor
startup inheritance records that decision. Restart forgets an abandoned representation. Its durable form is
the subject of the adjacent TODO, not a reason to keep the withdrawn live re-attempt.

The earlier resolution wrote
`operator_exit_representation_release_retry_exhausted` into the durable operator-disposition store and named
`durable-representation-release-reconciliation` as the successor. Both were wrong: that row is written as
`current-writer`, and the reconciler and its scheduler select only `stale` and non-canonical `successor-observed`
rows, so the writing process never reconciles its own row; and the successor that *would* eventually read it,
`#retireDurableSetDispositionsAfterContainmentAbsence`, retires the **row** and never terminalizes the
**operation**. The CLI's "no command is required: durable representation-release reconciliation owns the
remainder" was therefore false. The row, the refusal ground, the durable-write retry, and that CLI line are gone.

## Corrections to this branch's resolution

The first is the round-100 correction to the mechanism itself. The remainder are false sentences in published
history, recorded here because a reader meets this file and not a commit body, and because one of them reads
as a licence to delete a guard.

**Per-attempt accounting was not a status surface; it was a second failure path.** The row already witnesses
the outstanding operation, while the release disposition reports that delivery is failing. Writing the
delivery attempt into `revision`, `retryCount`, `retryNotBeforeMs`, and `lastError` made a lock refusal fatal,
logged alternating causes forever, committed forever, and paired host-refusal evidence with a count about a
different subject. `#recordReleaseAttempt` and its cause-comparison helper are deleted. The row now changes
only when provider-operation reconciliation changes it, not when release delivery fails around it.

**`28115ec6` says "the `currentDelivery` guard is not what defends a released slot". It is.**
`#releaseUndischargedRepresentation` sets no `terminalSettlement` and clears no `pendingOperations`, so of
`currentDelivery`'s three clauses only slot identity refuses a delivery outcome arriving after that release.
Removing it would let the retry sink arm a 1,000 ms timer on a slot `#clearRepresentationReleaseTimers` will
never run against again (the loop this entry exists to close), and let the fatal sink write a durable
operator-exit-refused row for an identity whose slot is gone, resurrecting the record
`#removeRepresentationSlot` had just deleted. Both are pinned by the two `refuses a … delivery whose
representation slot was already released undischarged` tests: deleting the clause turns both red.

**The correction above was itself imprecise, and `0a4ede46` acted on the imprecision.** "The `retry` and
`fatal` sinks are re-checked nowhere downstream" is true and irrelevant — nothing downstream needs to
re-check, because all three sinks evaluate `currentDelivery()` synchronously at the call site before invoking
their handler. `0a4ede46` read that clause as a gap and gave `#retainRepresentationRelease` and
`#failRepresentationRelease` a head guard repeating `currentDelivery`'s first clause; its own commit message
says the two sinks "were defended by nothing downstream", which is false in the only sense that matters. Both
head guards were unreachable — each method is `#`-private with exactly one caller — and the mutation table in
that round already showed it: deleting only the `currentDelivery` clause left the suite green *because the
head guards closed it*. The guards are deleted, and `currentDelivery` is the one place the predicate lives.

**The same commit's constraint comment claimed more than can be checked, and the claim is measurably
over-strong.** It said all three `currentDelivery` clauses are load-bearing and none subsumes the others.
Measured against the whole unit suite with the head guards gone: dropping the slot-identity clause alone
turns two tests red; dropping `terminalSettlement === null` alone leaves 8,272 tests green; dropping the
`pendingOperations` membership clause alone leaves them green; dropping both of those together turns one
test red (`tests/unit/jobs/shell/launch.test.ts`). Tracing why: on a fatally settled slot the retry sink's
whole effect is refused again downstream (`#scheduleRepresentationReleaseRetry` early-returns on
`terminalSettlement`, and `#finishInitialDisposition` meets an already-rejected latch), and the fatal sink's
is too (`#settleFatalRepresentationRelease` returns the existing settlement). The only consequence the
`terminalSettlement` clause uniquely prevents is the evidence sink deleting from `pendingOperations` on a
slot that has already settled, and nothing observes that. So the clauses are kept — each is cheap and
argued reachable — but the comment asserting three independent load-bearing clauses is gone, replaced by
the one clause a test actually proves. Do not restore the stronger claim without a case for each clause
that a test can see.

**`0a4ede46` fixed the shape of a retry after `4a092867` had already removed the probable producer.** The due
poll does short-circuit on the latched disappearance (`case 'ready': return Promise.resolve()`) before authority
lookup. That park is acceptable for disappearance because the first attempt has already released its launch
and recovery ownership, coordinator idle retirement gives it a bounded process exit, and startup re-observes
absence from durable provider-set facts. The re-attempt added by `0a4ede46`, and the helper-local fatal observer
added by `3da55840`, are therefore withdrawn. The extracted delivery helpers remain because the direct notice
entry points still call them.

## Most probable producer

The producer is traced and timing-consistent, not proven by the rotated log. On `origin/main`, a
`provider-proxy-lifecycle-fatal` selected hard shutdown. Hard shutdown's crashed-job terminalization obligation
calls `markJobsAsError`, which runs `runShutdownCrashTerminalization` over
`crashedJobTerminalizationSource`. That source selects every nonterminal projected job and does not exclude jobs
with surviving provider-operation rows; `createCrashedJobTerminalizationPolicy` likewise appends the crash
terminal without a provider-operation fence or deleting the saga row. A later disappearance terminalization
then appends both `job.progress.emitted` and `job.terminal.recorded`; `validateJobTerminalOrder` rejects the
first append after the existing terminal with `job_terminal_order_violation`. Startup rebuilds the same
disappearance observation from the surviving row, so the fixed one-second representation-release retry on
`origin/main` repeats it after every boot. `4a092867` changed this fatal reason to handoff mode, which does not
run hard-mode crashed-job terminalization. Those are the confirmed links; the historical log does not identify
the exact writer of its pre-existing terminal, so attribution of this chain to that incident remains the most
probable explanation rather than proof.

## What this does not settle

The 60-second live-slot retry still classifies every non-journal terminalization throw as
`retry-safe-unknown`, even though the one reachable deterministic member is concrete:
`validateJobTerminalOrder` rejects an append after a terminal. The classification change is deliberately not
part of this withdrawal. Its three observable answers and the existing `local-recovery-pending` successor are
filed in
[`provider-operation-terminalization-failure-classification`](./provider-operation-terminalization-failure-classification.md).
