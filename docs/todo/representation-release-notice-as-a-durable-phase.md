# TODO — abandonment is a durable provider-operation control intent

**Status**: open direction, narrowed on 2026-09-21. Disappearance is not part of it; abandonment is.

The earlier version proposed storing both disappearance and abandonment as a durable release phase. That put
an observation and a decision into one mechanism. They have different owners.

## Disappearance is observed, not stored

Containment disappearance must never be stored as a provider-operation decision. The world can answer it
again, and startup already asks. A surviving provider-operation row reaches `reconcileAtStartup`, which groups
the set and calls `recoverSetAtStartup`; production composition invokes `recoverProviderProxySetAtStartup`,
whose `set-inheritance` producer calls `inheritProviderProxySet`. Recorded containment absence returns
`containment-disappeared`; composition passes that observation to `containmentAbsent`, which dispatches the
same disappearance consumer. The restart path does not remember an old observation. It re-derives a current
one.

That is the named exit for the post-bound disappearance park described in
[`representation-release-retries-forever`](./representation-release-retries-forever.md). Storing the notice
would create durable evidence for a fact whose owner is the external world and whose freshness a later boot can
establish directly.

## Abandonment is a decision

Abandonment has no equivalent re-observation. `#consumeRepresentationAbandonment` constructs the literal
`coral_representation_abandoned` terminal directive only after the in-memory notice arrives, and no durable
field records that choice. Restart therefore forgets it.

The record already has the right form. `abort` calls `#requestControlIntent`, which writes
`controlIntent: { kind: 'stop', cause, requestedAt }` before the drive performs provider work.
`#rekeyRefusalDirective` derives the `coordinator_rekey_refused` terminal directive from another
`controlIntent` member during terminalization, and `#drive` drives the record's current decision. Abandonment is
the third decision of that species: write it before representation release, derive its terminal directive at
terminalization, and let `#drive` own progress.

If implemented, that shape deletes the abandonment latch, `#deliverLatchedAbandonment`, the literal directive
inside `#consumeRepresentationAbandonment`, and the `representation-abandonment-consumer` producer. It does not
store disappearance and does not add a generic release phase.

## The former obstacles are withdrawn

The abort fence is an entry effect of delivering a new decision, not a property the decision must retain.
`abort` already works without a separate delivery fence: it writes the control intent, then an older in-flight
drive loses a later compare-and-swap on `revision`. Abandonment can use the same ordering. The earlier claim
that the latch's active abort had to acquire a new durable owner was therefore not a blocker.

Generation is a timing fact, not a blocker. Provider-operation record generation 3 landed in `94204799` on
2026-09-12. As verified on 2026-09-21, `git tag --contains 94204799` returns no tag, so no released build selects
generation 3. Changing the strict v3 shape is free until the next release; after a release selects v3, the next
shape change requires a generation bump. This TODO should be decided before that window closes.

The remaining work is the record-shape and drive design itself, plus tests that prove abandonment survives a
coordinator restart. It is not part of the retry withdrawal.
