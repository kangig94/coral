# TODO — prove disappearance delivery stays owned through shutdown

**Status**: implementation landed; regression coverage and one ordering audit remain.

`ProviderOperationMutationAdmission` in `src/store/provider-operation-journal.ts` is shared by provider-event writes and `ProviderOperationReconciler.containmentDisappeared`. `buildProviderOperationMutationDrainObligation` in `src/coordinator/shutdown.ts` waits for that admission to close. If provider recovery remains held, the obligation defers closure and returns a hold.

The existing shutdown-budget and reconciler tests exercise other open mutations. They do not hold a disappearance delivery open across `stop()`, including when the shutdown budget is exhausted before mutation drain begins.

## Remaining proof

Drive the actual disappearance consumer through shutdown. Show that its mutation either settles before exit or remains under an explicit owner when the budget expires. Cover the provider-recovery-held branch where gate closure is deferred, so that ordering cannot let the coordinator exit with an open mutation admission.
