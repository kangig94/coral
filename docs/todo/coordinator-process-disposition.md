# TODO — process disposition is a recovery completion obligation

**Status**: open for registry abort custody and for recovery paths beyond the repaired binding-failure
branch. A binding failure no longer terminalizes a job while its durable carrier may be alive.

`registerRunningRecovery` in `src/coordinator/services/recovery/actions.ts` now observes or reaps the
durable carrier before settling a provider-binding fault. When cleanup remains held, it writes durable
containment status, keeps the `RecoveryRegistry` entry, and returns quarantine. The earlier claim that
this branch settled a repairable binding failure while blindly releasing its carrier is retired.

`RecoveryRegistry.abort` in `src/jobs/reconcile/registry.ts` still removes an entry as soon as an
`accepted` abort is delivered, before process absence or a successor's custody is established. That
shares the abort ownership question with
[`abort-answered-by-the-registry-not-the-saga-row.md`](./abort-answered-by-the-registry-not-the-saga-row.md).
An accepted signal alone cannot discharge a live carrier.

The wider recovery contract still has terminal and session-claim obligations without one required
`coordinator-process-disposition` obligation. Every path that terminalizes a runtime-bearing job must
first prove the exact process absent or transfer custody to an owner that accepted it. Unknown liveness
cannot authorize a terminal fact. Process-local cleanup may release in-memory references after that
disposition; it cannot serve as proof of absence.

## Start condition

Inventory coordinator actions that terminalize runtime-bearing jobs and cleanup callbacks that signal.
Prove, with crash-cut coverage, that no terminal fact is durable before process absence or verified
custody transfer. Make registry abort retain custody until absence is observed or a successor accepts it.
