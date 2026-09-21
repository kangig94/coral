# TODO — bugs found while sweeping comments

**Status**: open. This is a ledger of unrelated work, kept together because the comment sweep found each
member while walking code for another purpose. Implemented findings and findings whose premise did not hold
have been removed.

When a member needs a design of its own, graduate it to a concept entry and remove it here. Every member below
states only the work still owed.

## Distinguish three file-identity predicates

Three functions named `sameFileIdentity` implement two different contracts:

- `src/infra/bounded-file-read.ts` compares device, inode, mode, uid, size, and mtime.
- `src/runtime/real.ts` and `tools/simulation/core/memory-storage.ts` compare only device and inode.

The latter two are module-private, so there is no runtime collision, but a symbol search presents three
same-named predicates whose names do not say which identity they establish. Rename the private predicates so
the narrower device-and-inode contract is visible at the call site.

## Make the sessions-shell boundary true or narrow it

`releaseSessionJobClaim` (`src/sessions/job-release.ts`) says coordinator services use this sessions-domain
port instead of importing `sessions/shell`. `sessionManagerWithinTx`
(`src/coordinator/services/provider-event-application.ts`) nevertheless imports and constructs
`SessionManager` directly. Decide whether the service needs a wider sessions-owned contract and route it
through that contract, or narrow the stated boundary to the operation it actually governs. Do not leave a
layering rule that the tree already contradicts.

## Preserve fatal artifact invariants at discuss finalization

`LifecycleReactor.discardSessionArtifacts` (`src/sessions/lifecycle-reactor.ts`) rethrows
`ProviderArtifactArchiveInvariantError` and `ProviderArtifactProtocolInvariantError`, and its recovery policy
classifies those same errors as fatal. `finalizeSynthesizedSession`
(`src/discuss/shell/flow/synthesis.ts`) catches every rejection from the wired discard callback and reduces it
to a warning.

Choose the on-demand discuss disposition for those invariant failures — propagation, quarantine, or another
named fatal path — and preserve it instead of treating it as ordinary best-effort cleanup failure.

## Replace unresolvable specification labels

Comments across `src/` still cite labels such as `W2.3`, `W2.5`, `Spec §7.1`, `spec §6.4`, and
`invariant #44`, but the repository contains no document that defines those labels. A reader cannot verify the
claims they qualify.

For each citation, either link the source document if it is meant to be part of the repository, restate the
load-bearing constraint locally, or remove the citation if no surviving constraint depends on it. Do not
retain an external-looking label with no resolvable owner.

## Tie the two health shapes together

`BackendHealth` (`src/transport/http/backend/health.ts`) is the transport-side projection of
`HealthSnapshot` (`src/transport/server-ports.ts`). The duplication is required by layering and the shapes are
not literally identical — for example branded producer values become wire values — but no type assertion or
test defines and checks the intended projection. A producer field can therefore disappear at the transport
copy without a failure.

Define the projection relation and enforce it at type or test level without importing coordinator internals
into transport.

## Give `IpcRpcError.code` one owner

`IpcRpcError` (`src/transport/ipc/client.ts`) derives and stores `code` from `error.data.code` for CLI
rendering. `transportErrorEnvelope` (`src/cli/errors.ts`) passes `error.data` to `structuredBodyError`, which
derives the same code again; the other production catch sites only test `instanceof IpcRpcError`. No caller
uses the stored field.

Either make CLI rendering consume `IpcRpcError.code` or remove the redundant field and its claim. The code
must not have two derivations that can drift independently.

## Share the curate retry-queue sweep

`initializeCurateStateIfNeeded` (`src/kb/curate/state/bootstrap.ts`) and
`syncRetryQueueAgainstIncidents` (`src/kb/corpus/rescan/index.ts`) independently implement the same rule: delete
a retry row with a `canonicalIncident` when its entry id is absent from the current incident set. Extract one
owner for that predicate so bootstrap and rescan cannot diverge.

## Settle the unbuilt community-summary job path

`RunCommunitySummaryJob` (`src/kb/curate/scheduler.ts`) describes a runtime host that may wrap a summary as an
observable `kb.community_summary` job or call the agent directly. The only implementation,
`runCommunitySummaryJob` (`src/kb-daemon/runtime-host.ts`), forwards the scheduler signal directly to the
agent. The `kb.community_summary` literal appears in job schemas and read-side guards, but no launch path
constructs it.

Either build the observable-job path, including the promised cancellation composition, or remove the unused
job-operation vocabulary and describe the direct path as the contract.

## Cover every discuss event kind in projection parity

The discuss fixture used by the commit-time-reducer versus `rebuildProjections` parity test in
`tests/invariants/projection-rebuild-parity.test.ts` covers ten of the sixteen values in `discussEventKinds`
(`src/discuss/events.ts`). It omits `participants.expelled`, `speech.timed_out`, `epoch.summary.recorded`,
`must_answer.carry_forward.set`, `follow_up.queue.set`, and `follow_up.answered`.

Extend the fixture or the invariant so a reducer divergence for each omitted kind is observable.

## Remove or define the simulation sub-tick state

`InMemoryStorage.nextStamps` (`tools/simulation/core/memory-storage.ts`) sets `lastStamp` to at least
`previousMs + 1` and then tests whether the new value equals `previousMs`. That branch is unreachable, so
`subTickCounter` always resets to zero and never contributes to `mtimeNs`.

The counter is also part of the simulation snapshot shape. Decide whether snapshots promise sub-millisecond
ordering. If they do, implement a reachable same-tick scheme; if they do not, remove both the dead branch and
the serialized counter rather than leaving state that nothing advances.
