# TODO — provider-operation startup reconciliation can hold `starting` forever

**Status**: open. Split from issue #380, whose deadlock is fixed on its own branch; this entry is what that
fix deliberately left.

## The fact

Lifecycle Era II awaits `reconcileProviderOperationsAtStartup` before it registers the recovery component and
sets `running` (`src/coordinator/lifecycle.ts`). That call runs
`ProviderOperationReconciler.reconcileAtStartup` (`src/coordinator/services/provider-operation-reconciler.ts`),
and every awaited set recovery inside it goes through `awaitStartup`, which is bounded **only** by the
startup abort signal. That signal fires on shutdown, not on elapsed time.

So any wait inside startup reconciliation that never settles leaves the coordinator in `starting`: alive,
answering health, with no runtime components, and nothing — no timer, event, or retry — ending the hold.
Issue #380 was one such wait (a set fence awaiting a mutation in its own admission chain). That cause is
fixed; the absence of a bound is not, and the next unsettled wait reproduces the same symptom.

This is principle 11's "every hold names what ends it", and principle 12 makes it worse: nobody is watching
the machine where a backend sits in `starting`.

## What would close it

1. **A bound on startup reconciliation whose expiry is an outcome, not a hang.** When the bound passes, the
   set still being recovered becomes a `StartupReconciliationIncident` with a named successor — a set retry
   scheduled after startup, owned by the reconciler's due poll — and the lifecycle proceeds to `running`.
   What must not happen is the lifecycle waiting on the expired work, or treating the expiry as the set being
   recovered.
2. **A startup-level test.** A store holding a provider-operation record for a set whose processes are all
   absent must reach `running`. Issue #380's trigger was exactly that record, handed over by a previous
   backend whose shutdown recorded `provider operation mutation drain: timed-out`.

## Start condition

Decide the successor the expired set is handed to, and prove it can still discharge the set after
`running`: the due poll must be able to take a set whose startup recovery was abandoned mid-flight, including
any fence that recovery closed. Choosing the bound's value is the easy half.
