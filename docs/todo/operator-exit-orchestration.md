# The operator-exit orchestrator is safe and unreadable

`ProviderProxySetLifecycle.#completeOperatorExit` (`src/coordinator/services/provider-proxy-set/index.ts`)
was filed BLOCKING by a tier-3 reviewer in five consecutive rounds, always as size and branching. Three
of those were refused because length is not a defect. Measuring it rather than reading it found one that
was — the fence, and it is fixed — and a design ruling then established that the *reported* failures are
unreachable. What remains is a decomposition worth doing and deliberately not done here.

## What is settled, so it is not re-litigated

The reviewer named two failures. Neither is reachable.

**"Releases a mutation fence after a signal."** There is one lease, not two: the capability's containment
proof authorization *is* the journal mutation-set fence. It is released after signals on purpose, and
that direction is safe, because proof currentness tests the lease itself — a released lease answers
`authorization-stale`, so it cannot authorize a finalization. The failure would need a released lease
that still authorizes.

**"Returns a settled-looking result for a held release."** The settled kinds are minted only after an
evidence-backed commit, with the fatal case diverted first, and the release obligation is not hidden
beside the success: every non-completed claim discharge names what comes next — an `exit` while the
release is still held, or the surviving witness and its driver once the settlement bound has released the
slot undischarged — and the CLI refuses exit 0 for anything but a completed one.

Two narrower hazards the reports did not name were found in the same pass and closed: a currentness
dispatch that fell through to "current" for an unrecognised member, and a retention that was two calls
with nothing pairing them. Lease state per outcome now has tests, which it did not before — the method's
fence safety had rested on someone having read it.

## What is deferred

A decomposition, in descending value. None of it buys safety the current form lacks; all of it buys
readability for the next round, and this method acquires a branch nearly every round.

- **A containment-commit twin.** Abandonment commit is already extracted; containment commit is inline at
  depth two. The asymmetry is the reason the method reads as a cascade rather than a fork.
- **The abandonment decision recorded where its inputs are.** The decision is a function of the slot
  alone, and the capsule-recovering fork around it is written four times. Recording it inside the
  abandonment commit removes three copies; naming the fork once removes the fourth.
- **Two named predicates for capability currentness.** The comparison appears four times, twice
  deliberately without the deadline term. Naming both makes the omission visible instead of a shorter
  copy that reads like an oversight.
- **A reap wrapper.** Lowest value, and it moves the fingerprint that
  `tests/invariants/provider-proxy-recovery-policy.test.ts` pins for this method's `catch`, so it costs
  more than it returns until something else touches that.

## What must survive it

The tagged request union that made `boolean` × `abandon` unwritable. Both commit callees take the request
as the abandonment commit already does, so the guarantee holds by construction rather than by care.

And not the reviewer's prescription of fence ownership in each stage's return type: TypeScript cannot
express linear ownership. The transfer closure handed to the commit site is this repository's own form,
and ownership belongs at the commit rather than in a label a caller re-classifies.

## Start condition

The branch containing `ProviderProxySetLifecycle.#completeOperatorExit` has landed. Start when the next
change adds another branch here, or when the lease tests prove awkward to write against the current
shape — either is evidence the readability cost has caught up with the reason for waiting.
