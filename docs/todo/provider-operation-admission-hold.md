# TODO — indeterminate provider-operation ownership must hold startup admission

**Status**: open for an unreadable row whose job attribution is indeterminate. Readable rows and
unreadable rows with known job identity have narrower holds already; this entry asks how to protect
jobs when the row could name any of them.

`attributeUnreadableProviderOperations` in `src/store/provider-operation-journal.ts` distinguishes
`known` from `indeterminate` job attribution. `hydrate` in
`src/coordinator/services/recovery/provider-operation-startup-ownership.ts` builds
`unreadableSubjects` only from `known` values; `indeterminate` becomes `[]`. Known unreadable rows can
restore a permit and produce a startup hold. The indeterminate row fences no job, so generic recovery
can still finalize work that row may own. `snapshotProviderOperationStartupOwnership` is exposed through
`src/coordinator/services/recovery/index.ts`; its implementation lives in the startup-ownership module.

The `provider-operation-unreadable` recovery boundary exists in
`src/recovery/source-registry.ts`, and `discardUnreadableProviderOperationWithRecoveryAuthority` in
`src/store/provider-operation-journal.ts` provides a revision-checked discard path. That closes the
old entry's claim that there was no quarantine coordinate or discard command. It does not establish
which job an indeterminate row owns or make a global startup refusal safe.

## Required decision

A refusal must be a held lifecycle phase, with startup unresolved until admission is safe. It must
keep health and read commands reachable, refuse launches and subscriptions that cannot progress, and
skip store-wide job terminalization on shutdown. A retry must re-evaluate in the same process after a
supported repair. The earlier attempt returned ordinary startup success while refusing admission;
that made `backend status` report success, hid the hold from clients, and allowed hard shutdown to
terminalize protected jobs. That shape cannot return.

Represent the phase as `admission-held` in the lifecycle state, carrying the row keys and content
revisions that block admission. `LifecycleController.start()` must remain pending until the same
coordinator reaches `running`; shutdown while held rejects it. `backend status` must print the blockers,
IPC health must identify a reachable held coordinator, launches and `jobs.wait` must refuse promptly,
and `jobs.list`/`jobs.detail` stay readable. A held shutdown must avoid `markJobsAsErrorFn`, claim
release and store-wide cleanup because the indeterminate row can own any job. No second mutable
launch-fence flag should disagree with the lifecycle phase.

The proposed operator-clear or operator-abandon exit is **withdrawn by principle 12, No Operator Is
Watching**. The existing discard command can remain a manual remedy, but it cannot be the required
successor of an unattended hold. The automatic exit and its authority must be re-decided before a
startup-wide hold ships.

## Start condition

Decide a successor for an indeterminate row that does not depend on an operator, then implement the
held phase, client answers, held shutdown, and an in-process recheck as one unit. Prove that a malformed
current row cannot cause generic job terminalization while startup is held. A regression must show that
the same pending `start()` promise reaches `running` after a supported repair, with completion work
executed exactly once.
