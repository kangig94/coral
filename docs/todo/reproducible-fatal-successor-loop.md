# TODO — a fatal reproducible from durable state recurs in every successor

**Status**: open, inherited, bounded. Recorded 2026-09-17 from PR #363, which narrowed what each iteration
costs without ending the loop. Not a regression: the loop existed under hard mode and was more expensive
there.

## The loop

A successor coordinator discovers the previous coordinator's handoff capsule and redeems the set through
`#recoverExactCapsule` (`src/coordinator/services/provider-proxy-set/index.ts`). If redemption reproduces a
fatal identity or authorization invariant violation, a definitive non-availability remote refusal, or a malformed result that breaks
its contract — the same violation that made the previous coordinator declare its
judgement void — `retireFatal` (`src/coordinator/services/provider-proxy-recovery-policy.ts`) reaches
`onProviderProxyLifecycleFatal` (`src/coordinator/composition/execution-assembly.ts`), which starts a
`provider-proxy-lifecycle-fatal` shutdown. That shutdown is handoff: it leaves the capsule where the next
coordinator will find it. The next CLI command spawns a successor, which reads the same capsule, asks the same
guardian, and gets the same fatal violation.

This capsule loop remains open for typed identity/authorization invariants, definitive non-availability remote
refusals, and malformed producer results. Unknown `capsule-redemption`, `set-inheritance`, and
`containment-proof` rejections follow the durable exact-subject
[hold contract](../architecture.md#containment-evidence-and-reclamation), rather than this shutdown loop.
The other producers whose unclassified rejections remain fatal are `disappearance-terminalization`,
`role-control`, `capsule-retirement` outside the foreign-capsule seam, `disappearance-consumer`, and
`representation-abandonment-consumer`; their typed retry exceptions and the full fatal inventory are in the
[fatal-mode rationale](../design-rationale.md#121-why-a-provider-proxy-lifecycle-fatal-takes-handoff).
Those other paths do not establish an unknown-redemption capsule loop.

Each iteration costs one CLI invocation an exit-`75` refusal and a fresh coordinator spawn. The originating
fatal is itself a terminal shutdown incident, independent of cleanup losses, so even a completely clean drain
exits nonzero and writes a `shutdown-remainder.v1.json` record with reason
`provider-proxy-lifecycle-fatal`. The recurrence is therefore visible in the run directory without relying on
an unrelated cleanup failure.

## What bounds it

The enforcers. `consumeHolderObservation` in `createArmedEnforcer` (`src/provider-proxy/enforcement.ts`)
observes the control holder at anchor + `orphanTimeoutMs − teardownReserveMs`; each coordinator in the loop
dies before renewing, the holder is observed absent, and the guardian and reaper tear the set down through
`reapRecordedContainment` when their own authority and process observations permit it. Capsule retirement
still requires decisive absence under the applicable [containment evidence contract](../architecture.md#containment-evidence-and-reclamation);
a teardown attempt or deadline alone cannot supply it. Under hard mode every iteration also reaped every
healthy set on the way down; under handoff it costs the bad set and nothing else.

## Why it was left

Ending the loop earlier means a successor deciding not to redeem a capsule because a predecessor reported a
fatal from it. That is a retirement decided on the evidence the predecessor just declared it could not
interpret, and [`design-philosophy`](../../.claude/rules/design-philosophy.md) §11 forbids finalizing on
evidence that did not decide. Confirmed disappearance under the [containment evidence contract](../architecture.md#containment-evidence-and-reclamation) is decisive evidence; the enforcers retain responsibility for obtaining it.
Buying the iterations back would require a coordinator to hold a judgement the fatal says it does not have.

## What closing it requires

A per-capsule durable observation — "instance X met a fatal redeeming this capsule at T", written by
the failing coordinator beside its remainder record — that a successor reads to defer redemption of that one
capsule while the enforcers run, keeping every other set redeemable. This keeps §11 intact and costs a new
durable shape at a new address. Repeated fatal invariant or malformed-result failures alone cannot prove
process absence or authorize capsule retirement.

**Interaction.** Adjacent to [`legacy-v1-capsule-retirement`](./legacy-v1-capsule-retirement.md), whose
question is the same one from the other side — what may retire a capsule when no observation decides — and
to [`foreign-capsule-retirement-terminal-recovery`](./foreign-capsule-retirement-terminal-recovery.md), which
wants a durable receipt for a retirement that did happen. The observation this entry proposes is the same
kind of record; whichever lands first pays for its shape. The no-daemon remainder reader is where the
recurrence is seen. The generic settlement fallback liveness gap is unrelated and does not block observing
this loop.
