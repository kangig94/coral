# TODO — project held shutdown state through health

**Status**: open. Live held-state projection and one generic hold fallback remain.

## The live coordinator does not project its held boundary

`LifecycleShutdownRecovery` (`src/coordinator/lifecycle.ts`) already carries the held boundary's `reason`,
`exit`, retry attempts, retained authority, and cleanup obligations. `HealthSnapshot`
(`src/transport/server-ports.ts`) exposes lifecycle phase but none of that recovery disposition, so a live
coordinator can report `draining` without saying what holds the boundary or what observable event ends it.

The projection must carry the existing held `reason` and `exit`. It must not invent a `transfer-pending`
lifecycle state: `GateResolution` (`src/obligation/settlement.ts`) has only `held` and `terminal`. A declined
prepare or commit is held; final boundary exhaustion or a successful commit is terminal.

This is Track B of kangig94/coral#357.

## A generic settlement hold can lose its retry wakeup

`SettlementHold` (`src/obligation/settlement.ts`) makes `retryAfter` optional. When a boundary omits it,
`SettlementLedger.createHeldDisposition` in the same file falls back to
`this.options.time.sleep(this.options.pollMs)`. `time.sleep` (`src/infra/time.ts`) unrefs its timer, so after
the IPC listener and HTTP server close the process may have no referenced handle left to keep it alive until
that fallback resolves.

`buildAuthorityReleaseBoundary` (`src/coordinator/shutdown.ts`) is the only production boundary today and its
`hold()` always supplies a `retryAfter` wrapped by `keepaliveGuardedRetryAfter`, so the fallback is not reached
by the current composition. Close the gap either by applying the same keepalive in the ledger fallback or by
making `retryAfter` required, so a future boundary cannot silently select an unref'd retry.

These two changes are independent: projecting a hold makes its disposition visible; keeping its retry alive
makes the automatic exit reachable.
