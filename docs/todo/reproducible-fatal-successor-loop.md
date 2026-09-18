# TODO — a fatal reproducible from durable state recurs in every successor

**Status**: open, inherited, bounded. Recorded 2026-09-17 from PR #363, which narrowed what each iteration
costs without ending the loop. Not a regression: the loop existed under hard mode and was more expensive
there.

## The loop

A successor coordinator discovers the previous coordinator's handoff capsule and redeems the set through
`#recoverExactCapsule` (`src/coordinator/services/provider-proxy-set/index.ts`). If the guardian answers out
of contract — the same corrupt, refused, or unknown evidence that made the previous coordinator declare its
judgement void — `retireFatal` (`src/coordinator/services/provider-proxy-recovery-policy.ts`) reaches
`onProviderProxyLifecycleFatal` (`src/coordinator/composition/index.ts`), which starts a
`provider-proxy-lifecycle-fatal` shutdown. That shutdown is handoff: it leaves the capsule where the next
coordinator will find it. The next CLI command spawns a successor, which reads the same capsule, asks the same
guardian, and gets the same answer.

Each iteration costs one CLI invocation an exit-`75` refusal and a fresh coordinator spawn. The originating
fatal is itself a terminal shutdown incident, independent of cleanup losses, so even a completely clean drain
exits nonzero and writes a `shutdown-remainder.v1.json` record with reason
`provider-proxy-lifecycle-fatal`. The recurrence is therefore visible in the run directory without relying on
an unrelated cleanup failure.

## What bounds it

The enforcers. `consumeHolderObservation` in `createArmedEnforcer` (`src/provider-proxy/enforcement.ts`)
observes the control holder at anchor + `orphanTimeoutMs − teardownReserveMs`; each coordinator in the loop
dies before renewing, the holder is observed absent, and the guardian and reaper tear the set down through
`reapRecordedContainment` within one adoption window. After that the capsule's three recorded processes are
absent and the capsule is retirable on the next discovery. Under hard mode every iteration also reaped every
healthy set on the way down; under handoff it costs the bad set and nothing else.

## Why it was left

Ending the loop earlier means a successor deciding not to redeem a capsule because a predecessor reported a
fatal from it. That is a retirement decided on the evidence the predecessor just declared it could not
interpret, and [`design-philosophy`](../../.claude/rules/design-philosophy.md) §11 forbids finalizing on
evidence that did not decide. The enforcers' teardown is the decisive evidence, and it arrives by itself.
Buying the iterations back would require a coordinator to hold a judgement the fatal says it does not have.

## What closing it requires

Either a per-capsule durable observation — "instance X met a fatal redeeming this capsule at T", written by
the failing coordinator beside its remainder record — that a successor reads to defer redemption of that one
capsule while the enforcers run, keeping every other set redeemable; or a ruling that N recorded fatals for
one capsule inside one adoption window is decisive evidence for retirement, with N and the window argued
rather than picked. The first keeps §11 intact and costs a new durable shape at a new address; the second is
a decision about what may end a hold when the only evidence is repetition.

**Interaction.** Adjacent to [`legacy-v1-capsule-retirement`](./legacy-v1-capsule-retirement.md), whose
question is the same one from the other side — what may retire a capsule when no observation decides — and
to [`foreign-capsule-retirement-terminal-recovery`](./foreign-capsule-retirement-terminal-recovery.md), which
wants a durable receipt for a retirement that did happen. The observation this entry proposes is the same
kind of record; whichever lands first pays for its shape. The reader in
[`shutdown-remainder-has-no-reader`](./shutdown-remainder-has-no-reader.md) is where the recurrence would be
seen, so that entry should land before this one is judged worth its cost.
