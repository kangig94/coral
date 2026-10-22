# TODO — re-evaluate stale quarantine rows

**Status**: open for startup re-evaluation. The historical row counts came from a retired flat store and do not describe the active epoch.

`RecoveryQuarantineStore` in `src/recovery/quarantine.ts` retains rows until an explicit clear or boundary retry. A changed build can stop producing a subject while its old row continues to report degraded health. The per-subject clear path can remove a row whose narrowed scan no longer finds it; startup does not automatically re-evaluate all retained subjects against current sources. Give that re-evaluation a recovery owner and an unattended exit, including continuation rows whose work has since completed.

The provider-binding retry finding is resolved by execution retention. `LifecycleReactor.providerCleanupReadiness` in `src/jobs/conversation/lifecycle-reactor.ts` returns an unavailable disposition when the captured binding cannot be rehydrated before discard. `LifecycleReactor.settleRetention` returns a failed settlement; `ExecutionFinisher` in `src/jobs/finishing.ts` records `job.retention.discard.failed` before ending the execution. It does not retarget the conversation to a different account. An already-issued discard remains subject to its original action reconciliation.

The `rqk1-` operator coordinate makes existing rows individually addressable. Individual operator clears cannot be the required exit on an unattended machine under principle 12.

## Start condition

Implement startup re-evaluation for rows whose source no longer yields a subject.
