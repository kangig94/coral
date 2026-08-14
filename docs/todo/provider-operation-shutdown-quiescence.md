# TODO — provider-operation shutdown quiescence at the mutation boundary

**Status**: open. Split out of PR #308 on 2026-08-14 after two review rounds found that the inline
reconciler drain fenced only part of the mutation surface. The authority-fault containment fix does not depend
on this work and must not carry another partial version of it.

## The bug

Shutdown calls `stopProviderOperationReconciler()` before the accepted-request drain begins
(`src/coordinator/lifecycle.ts:1233-1239`). That stop unsubscribes
`subscribeProviderOperationMutations` immediately (`src/coordinator/composition/execution-services.ts:375-379`),
while `ProviderOperationReconciler.stop()` only disables scheduled polling and removes its settlement listener
(`src/coordinator/services/provider-operation-reconciler.ts:444-451`). It neither fences nor awaits an active
serializer; those serializers remain represented only by the per-operation `inFlight` promise
(`src/coordinator/services/provider-operation-reconciler.ts:732-771`).

An already accepted drive can therefore commit its journal record to `executing` and publish the provider root
after the claim-mirror subscription is gone (`src/coordinator/services/provider-operation-reconciler.ts:1581-1650`).
If its subsequent attach hits a retry-safe failure, the preserve decision reads the stale mirror and can report
`liveClaims=0` (`src/coordinator/services/provider-proxy-set/index.ts:435-461`). A concurrent retirement then
uses the same zero-claim view to authorize stop-and-reap (`src/coordinator/services/provider-proxy-set/index.ts:883-893`),
killing an operation whose durable claim was committed but never reached the mirror.

## This is pre-existing

The core shutdown bug predates this branch. At merge base `b0cfb406`, `createLifecycle.shutdown()` already
called `stopProviderOperationReconciler()` before `runShutdownSequence`, the execution-services stop already
unsubscribed the mutation listener immediately, and graceful-idle plus excess-capacity retirement already
consumed `claimsFor(...).length === 0`. Removing the inline drain therefore restores a pre-existing defect; it
does not regress the shutdown ordering or those retirement checks.

This branch does add one more mirror reader: recovered `unclaimed_discovery` now checks `liveClaims === 0`
before authorizing retirement (`src/coordinator/services/provider-proxy-set/index.ts:856-860`). At the merge
base that path contained the discovered set unconditionally, so the new guard does not make that path more
aggressive than the old behavior. It does, however, make the stale-mirror defect part of one more authority
decision and must be included in the eventual regression matrix.

## Why the inline fix failed

The attempted fence lived inside `ProviderOperationReconciler`. It covered `begin()`, polling,
control-established reconciliation, `reconcile()`, and disappearance admission, but provider-operation
admission spans more than that class:

- Provider-event application can write `settlement-pending` through `markSettlementPending`
  (`src/coordinator/services/provider-event-application.ts:393-412`) without passing through the reconciler
  fence.
- `requestStop()` enters `#requestControlIntent` (`src/coordinator/services/provider-operation-reconciler.ts:642-650`),
  whose compare-and-swap writes (`:1849-1913`) were not fenced or tracked.
- `withBudget` skips a task entirely when no drain budget remains
  (`src/coordinator/shutdown.ts:86-97`), so the drain was not guaranteed to run at all.
- On budget expiry, the implementation aborted only each serializer's `activeAbort`. Disappearance delivery
  was tracked by a separate non-rejecting join and received no abort signal, so expiry could return while that
  mutation continued unsignalled.

The non-rejecting `join` seam also separated what the caller observed from what the drain observed. That made
the bookkeeping harder to audit without fixing the ownership boundary: a reconciler-private flag could never
cover writers that do not enter through the reconciler.

## Shape for the next design

Put one shared admission/tracking gate at the actual provider-operation mutation boundary and have execution
services own it. Provider-event application and stop-intent admission must acquire the same gate before they
write, alongside request-driven and reconciliation work. Shutdown closes that gate synchronously, preventing
new acquisitions, and then drains everything that acquired before the close.

The gate is an execution-services lifetime primitive, not a reconciler mode. Its acquired scope must cover the
durable mutation and the claim-mirror publication that makes that mutation visible to retirement decisions.
The design pass must name every writer of the provider-operation journal and prove that each either acquires
the gate or is impossible during shutdown.

## Regression requirements

- The drain must be invoked even when no shutdown budget remains. An exhausted budget may make its signal
  already aborted or force immediate containment, but it must not skip closing and observing the gate.
- Budget expiry must fence disappearance delivery as well as active serializer drives. No tracked mutation may
  continue without a signal after shutdown moves on to provider-set retirement.
- A regression must hold accepted work open across the drain, assert that the drain remains pending, and only
  then release or expire that work. Completing the drive before invoking the drain proves nothing; that is how
  the first attempt shipped without exercising its claimed ordering.
- Cover request-driven publication, polling/control-established work, provider-event settlement, stop intent,
  and disappearance delivery under both normal and already-exhausted shutdown budgets.
