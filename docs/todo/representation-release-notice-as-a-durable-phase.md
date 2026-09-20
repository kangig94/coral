# TODO — the release notice could be a durable phase instead of an in-memory latch

**Status**: open direction, not attempted. Recorded so a later round does not rediscover it without the two
obstacles that stopped it here.

A disappearance or abandonment notice lives in memory, on `OperationSerializer.disappearance` /
`.abandonment` inside `ProviderOperationReconciler`
(`src/coordinator/services/provider-operation-reconciler.ts`). Around it sit two near-identical delivery state
machines (`ready | delivering | consumed`), an unawaited kick from `reconcile`, and — since the release bound
landed — a durable record that already carries the attempt accounting for exactly the same work.

The direction: make the notice a durable transition of the provider-operation record, the way
`prestart-cleanup-pending.afterRelease` already is. Terminalization then becomes a driven phase like every
other, the due index is the only scheduler, and the latch, both delivery machines and the unawaited kick are
deleted rather than maintained. That is the shape the last five class-ending changes on this branch took:
remove the mechanism, do not tune it.

It was not chosen because two things have to be shown first, and neither could be shown end to end here.

**The latch's second job is an abort fence, and a revision compare-and-swap is not one.** Setting
`serializer.disappearance` also bumps `serializer.epoch` and calls
`serializer.activeAbort?.abort(new RepresentationDriveFencedError())`. That is what preempts a drive already
awaiting a provider round-trip — the `fences a blocked executing attach and acknowledges disappearance only
after terminalization` test is the case. A durable phase transition refuses a *later* write by the fenced
drive; it does not stop the in-flight one from waiting. Something still has to abort the running drive, so the
deletion is not purely subtractive unless that fence finds another owner.

**Every record schema is `.strict()`, so a new phase or field is a generation question.** Adding a
`release-pending` phase or a notice field to `providerOperationRecordSchema`
(`src/store/provider-operation-record.ts`) is additive and therefore allowed under `design-philosophy`
principle 10 — but the meta-key namespace is derived from `PROVIDER_OPERATION_RECORD_VERSION`, and a build
that does not know the new phase must skip such a row visibly rather than fault on it. The mixed window is
real: updating the plugin swaps the CLI while the coordinator keeps serving on the build it started with.

A third thing worth measuring before committing: whether the durable phase changes what `backend status`
shows for an operation whose release is pending, and whether that is an improvement or one more status the
reader cannot act on (principle 12).
