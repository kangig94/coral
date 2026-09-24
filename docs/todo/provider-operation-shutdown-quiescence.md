# TODO — cover disappearance delivery across provider-operation shutdown drain

**Status**: implementation landed; one regression proof remains.

`ProviderOperationMutationAdmission.run` and `close` in `src/store/provider-operation-journal.ts`
now share one mutation gate. `createProviderEventHandler` in
`src/coordinator/services/provider-event-application.ts` enters it for provider-event writes.
`ProviderOperationReconciler.requestStops` and `containmentDisappeared` in
`src/coordinator/services/provider-operation-reconciler.ts` use the same admission, and `stop`
closes it. `buildProviderOperationMutationDrainObligation` in `src/coordinator/shutdown.ts`
waits for that close and names a retained hold when it does not drain. The old `withBudget` skip
and reconciler-private drain design are gone.

The shutdown obligation first waits for provider recovery to discharge; while that obligation is held,
it returns a hold without closing mutation admission. The remaining proof must show that this ordering
retains a live owner and does not let exit pass a still-open gate.

The shutdown-budget test holds a mutation open across drain, and the reconciler test holds an
activation open while `stop()` closes admission. Neither demonstrates a disappearance delivery
held open across `stop()` and then settled or expired. That path was the original un-signalled
mutation: a separate delivery join could outlive the old drain. The shared admission now covers
it in source, but a regression should prove the ordering and the already-exhausted shutdown-budget
case through the actual disappearance consumer.

## Start condition

Hold `ProviderOperationReconciler.containmentDisappeared` open, start shutdown, and assert that the
mutation drain remains held until delivery settles or its owner retains an explicit hold. Include a
budget already exhausted before drain starts, and the provider-recovery-held branch that defers gate
closure. This is coverage and an ordering audit for the shipped boundary.
