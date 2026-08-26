# Handoff graces use wall time

## The violated rule

`.claude/rules/validation.md` makes this BLOCKING: process-reaping graces use `createMonotonicClock`, never
wall-clock time. The handoff state machine in `src/coordinator/handoff.ts` instead reads elapsed-time
authority through `runtime.time.now()` for its total bind deadline and both accepted-signal graces. The real
Runtime implements that port value with `Date.now()`.

This is not a formatting preference. Elapsed-time authority cannot come from a clock an administrator,
hypervisor, or time synchronizer may move.

## The two wrong directions

A backward wall-clock adjustment lengthens the apparent remaining budget and can stall escalation after the
real grace has elapsed. A forward adjustment spends the budget without elapsed time and can run the final
target observation before the signal's required grace has passed. The first leaves a contender waiting past
its bound; the second reports a post-grace disposition it has not earned.

Both directions affect the same state machine. Migrating only the two signal timestamps would still leave the
outer handoff deadline in another clock domain, while migrating only the deadline would leave the delivery
graces unsound.

## Why it did not join the signal-delivery repair

Correcting delivery is a contained evidence change: a failed send no longer writes the ledger or arms a
grace, and accepted-signal exits now settle their target. Correcting elapsed time changes the current state
machine's deadline and grace transitions plus the virtual-time tests that drive them. Combining those changes
would make a reviewer unable to tell whether a new outcome came from delivery evidence or from a different
clock.

The current timing remains intentionally unchanged here. This entry records the BLOCKING violation; it does
not waive it.

## Start condition

Start after the signal-delivery change is reviewed independently. Replace the handoff state machine's one
wall-clock domain as a unit with `createMonotonicClock`, including the total deadline, both signal timestamps,
all remaining-budget arithmetic, and the tests that advance those transitions. Do not begin with a subset of
the `runtime.time.now()` calls that supply those decisions.
