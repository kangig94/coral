# TODO — a retirement that completed leaves no receipt, only a directory to rescan

**Status**: open, and split out of G3 rather than deferred by it. G3 retires a foreign capsule whose three
recorded processes are proven absent, retries a failed cleanup four times, and then stops holding it: the
in-memory owner is dropped, the conservative representation stands for the rest of the boot, and a
still-readable capsule is retried by a later boot's discovery. That is a deliberate acceptance of bounded,
non-capacity-consuming residue, not a claim of crash-exact durable recovery. This entry is the stronger claim.
Pursuing it means adding a recovery boundary, and the prerequisites below are what that costs — they are
prerequisites for the work, not work this batch authorized.

## What G3 accepts, stated so the acceptance is not mistaken for an oversight

Retirement runs on a new `foreign-capsule-retirement` consumer seam over the existing `capsule-retirement`
producer (`src/coordinator/services/provider-proxy-recovery-policy.ts`). Every producer rejection and
every malformed fulfillment on that seam becomes an owner-local `unavailable` incident instead of reaching the
global fatal sink — `classifyRejection` takes the seam for exactly that
(`src/coordinator/services/provider-proxy-recovery-policy.ts`). Attempts 1 to 4 wait on the existing
`retryDelayMs` schedule (`src/coordinator/services/provider-proxy-set/index.ts`) — 1s, 2s, 4s, 8s — and
`FOREIGN_CAPSULE_RETIREMENT_ATTEMPT_LIMIT` is the named end: one warning carrying the path, the
attempt count and the incident, then the owner is removed and no sixth attempt is made.

Bounding a hold that way is only sound because the owner holds nothing else. It holds a path whose file is
either already gone or already the durable refusal status; abandoning it returns to exactly the representation
today's handling installs and keeps for a whole boot with no retry at all. The owned retirement seam is
deliberately unbounded for the opposite reason — its evidence is the only thing that reaches
`#releaseAbsenceSlot`, so abandoning it would strand that slot and its identity-index entry.

## The one reachable residue, and why it is not an obligation

`retireProviderHandoffCapsule` (`src/coordinator/services/provider-proxy-capsule-discovery.ts`) unlinks the
capsule, swallows `ENOENT` on a repeat, and reports `retired` only when the directory sync succeeds.
So the interesting case is an unlink that succeeded and a directory sync that did not, followed by
a crash: the entry can come back readable.

Nothing durable was told the capsule was retired, which is what makes that a rescan rather than a
disagreement. Retirement truth is re-derived by scanning the run directory on every boot, no durable record
anywhere names a capsule path or its grant, and the grant secret is dead because all three recorded processes
were observed absent before retirement began. A restored readable entry therefore meets the ordinary
all-absent decision again and is retired from scratch. What is missing is not an owner — it is a receipt.

## What a crash-exact receipt would have to be

A record, written before the unlink and readable after a crash, that says this build decided a specific
capsule path was retirable on decisive evidence. Its value is not the deletion, which re-derives; it is the
evidence and the decision, which do not. Two things follow from Principle 11: the receipt must name what
retires it, and a receipt this build cannot decode must be skipped and reported rather than trusted or
destroyed. Principle 10 then governs its address, not a `version` field inside it.

## Prerequisites for a new recovery boundary

Four, and none is discretionary. Each is a fact about the tree measured while G3 was implemented.

1. **The `complete(expectedRetry) === false` successor state is undecided.** `complete(expectedRetry)` names
   the shape, not a symbol: a claimed retry completes through a compare-and-set — `delete` and `upsert` take
   `expectedRetry` (`src/recovery/quarantine.ts`) — and when it answers `false` the retry no longer owns the
   row. `deleteCompletedRetry` and `completeAbsentRetry` (both `src/recovery/containment.ts`) both
   answer that with a thrown `Error` and nothing else, so there is no named state the row is
   in afterwards. For a subject keyed by a capsule path the question is not academic: `generationRunDir`
   (`src/infra/path/coordinator.ts`) is scoped by flavor and generation only, so the run directory is
   shared across builds and the key is not build-scoped. This decision is recorded as unresolved; the plan
   that produced this entry carries no answer to it.
2. **The narrow facet must be constructible before the thing it settles exists.**
   `assertRecoverySourceRegistryComplete` (`src/recovery/source-registry.ts`) runs at
   `src/coordinator/composition/index.ts`, so every `register` call precedes it —
   while `createExecutionServices`, which constructs `ProviderProxySetLifecycle`, is called after it. A
   foreign-retirement source therefore cannot close over the lifecycle object. It needs a narrow facet built
   synchronously ahead of it and resolved at retry time, in the shape the existing factories already use.
3. **Three literal lists restate the boundary manifest.**
   `tests/unit/recovery/retry-service.test.ts` writes the eleven boundary ids out again as an expected
   array, then a second time as an array of real source constructors, then a third time as a
   runtime-registration block. A new boundary is an edit to the manifest
   (`src/recovery/source-registry.ts`) and to all three, and the test fails until the four agree.
4. **The composition suite needs a boundary-specific `until-cleared` fixture.**
   `tests/unit/coordinator/recovery-quarantine-composition.test.ts` drives every registered boundary
   through one `it.each` that builds its subject with a `fingerprint` revision. A capsule path has no content
   fingerprint, so this boundary's revision is `until-cleared`, which `clearSubject`
   (`src/recovery/source-registry.ts`) produces from a `null` wire revision. The generic row would
   exercise the wrong revision kind, so the fixture has to grow a case rather than a parameter.

## What the review rounds demolished

Six designs were proposed and rejected before the split settled on a receipt. Naming them matters because a
later reader cannot re-derive a rejected design from the code that does not contain it. For three of them the
reasoning survives in the plan and is written out; for the other three it was not carried into either the plan
or the preplan, and an honest gap is recorded instead of a reconstruction.

- **A durable-obligation subsystem** — rejected, and the reasoning survives. After a successful unlink there
  is no obligation left to own: nothing durable records that a capsule was retired, so nothing can fall out of
  step with the filesystem. What is wanted here is a stronger crash-exact receipt, not an owner for a live
  obligation, and a subsystem built to hold obligations would have nothing to hold.
- **A quarantine row** — rejected, and the reasoning survives. A durable row is the Principle 11 exit for a
  hold that strands something. This hold strands nothing: abandoning the owner returns to the status quo ante,
  so the row would protect nothing and would itself become durable state with no lifecycle owner.
- **An operator command** — rejected for the same reason, and the pairing is the reason. A quarantine row
  without a supported clear is a hold no operator can end, and a clear command for a subject whose abandonment
  costs nothing is a decision with no content. The two stand or fall together, and here they fall.
- **A transport/CLI surface** — rejected. **The rationale was not carried into the plan or the preplan.** What
  the plan does record is the exclusion itself: the durable follow-up is not added to the existing
  recovery-quarantine surface or to `StartupReconciliationReport`. That is the decision, not the argument for
  it.
- **A pathname-idempotency scheme** — rejected. **The rationale was not carried into the plan or the
  preplan.** The plan does record one adjacent fact, which is not the same as the reason the scheme was
  rejected: retry is already idempotent, because a repeated unlink swallows `ENOENT` and only the directory
  sync is re-attempted.
- **A fail-closed startup hold** — rejected. **The rationale was not carried into the plan or the preplan.**
  The plan does record a constraint any such design would have to satisfy, again not the reason for the
  rejection: capsule installation runs inside Era II ahead of the startup recovery barrier, and everything
  from `runStartupRecovery` through the launch-fence release, `setLifecycle('running')`, the KB supervisor and
  Era III sits behind that one await, so nothing on that path may block.

## How this interacts with the two entries that also want a boundary

It shares the recovery-boundary prerequisite with
[`provider-operation-admission-hold.md`](./provider-operation-admission-hold.md) and
[`coordinator-process-disposition.md`](./coordinator-process-disposition.md), and **it does not ship with
either.** What they share is shape cost, not a disposition: `repeatableRecoveryBoundaryIds` is a closed
manifest checked for exact equality, so each new subject kind is its own registered boundary with its own
source and policy, and whichever of the three lands first pays for the registry factory, the restated lists in
prerequisite 3, and the composition ordering in prerequisite 2. The other two then inherit that and add
their own boundary.

Their dispositions do not merge. Admission-hold is a startup-wide refusal whose exit is an operator clear or
abandon; coordinator-process-disposition is a custody transfer verified by receipt before ownership is
released; this one is a retirement receipt for a path this build may not dial. And this one is last of the
three by need, not only by order: its residue is already bounded and consumes nothing, so it has the weakest
claim on introducing a boundary. It should not be the entry that introduces the shape.

## Explicitly out of scope

The V2/V3 observe-then-retire decision, which shipped. The undecidable-absence members, which are
[`legacy-v1-capsule-retirement.md`](./legacy-v1-capsule-retirement.md) — that entry is about capsules where no
evidence retires anything, this one is about a retirement that already happened on decisive evidence and left
no proof of itself. Fixing either leaves the other untouched. Also out of scope: making the foreign seam fatal,
or extending `ProviderProxySetLifecycleProgressViolation` to record retry lateness — the seam's whole property
is that no way it can fail is evidence about this coordinator.

## Start condition

A reason to want crash-exactness that the rescan does not already serve. The residue is one readable file
retried by the next boot, and every term of that is measured above; a receipt costs a new recovery boundary
with four prerequisites and an unresolved successor-state decision. The honest trigger is either a case where
the rescan cannot run — a run directory this build will not discover again — or one of the two neighbouring
entries landing first and paying the boundary cost, after which this becomes an increment rather than a
subsystem.
