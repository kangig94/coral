# TODO — re-evaluate stale quarantine rows and settle permanent retention binding refusals

**Status**: open for two recovery dispositions. The historical row counts came from a retired flat store and do not describe the active epoch.

`RecoveryQuarantineStore` in `src/recovery/quarantine.ts` retains rows until an explicit clear or boundary retry. A changed build can stop producing a subject while its old row continues to report degraded health. The per-subject clear path can remove a row whose narrowed scan no longer finds it; startup does not automatically re-evaluate all retained subjects against current sources. Give that re-evaluation a recovery owner and an unattended exit, including continuation rows whose work has since completed.

`LifecycleReactor.enforceRetention` in `src/sessions/lifecycle-reactor.ts` calls `readyBoundProvider` and throws when the captured provider binding cannot be rehydrated. A different logged-in account is correctly refused for artifact deletion, but treating that standing mismatch as a retryable quarantine causes the same work to be retried indefinitely. Decide whether such a mismatch terminalizes retention work, remains held with an automatic successor, or has another durable disposition. A retry must never retarget the session to a different account.

The `rqk1-` operator coordinate makes existing rows individually addressable. Individual operator clears cannot be the required exit on an unattended machine under principle 12.

## Start condition

Implement startup re-evaluation for rows whose source no longer yields a subject. Separately choose the durable outcome and visible status for a provider binding that no longer matches the session's captured account.
