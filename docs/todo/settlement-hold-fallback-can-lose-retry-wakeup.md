# TODO — keep a generic settlement hold's fallback retry alive

**Status**: open. One generic hold fallback remains.

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

The fixed ledger schedule races this fallback against the current slot deadline, but that does not decide
whether the fallback sleep should keep the process alive. That liveness choice remains independent.
