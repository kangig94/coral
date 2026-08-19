# TODO — a capsule whose recorded absence cannot be decided

**Status**: open, and narrowed rather than inherited. G3 closed the half of foreign-capsule retirement that can
be decided: an uninheritable V2 or V3 capsule whose three recorded processes are each observed `absent` is
retired through the existing `capsule-retirement` producer, and the representation installed for it is dropped
with it. What is left is the population no observation this build can take will settle. Nothing blocks the
entry; nothing available decides it either, so what it needs is evidence rather than code.

## The concept has three members, and only the first is a version

`recordedProcessesAllAbsent` (`src/coordinator/services/provider-proxy-set/index.ts`) retires only on proof,
and `createRecordedProcessObserver` (`src/infra/node-process.ts`) is what supplies it: a readable incarnation
that disagrees with the recorded one is `absent`, a matching one is `alive`, no recorded incarnation or an
unreadable probe falls back to liveness, and either reader failing is `unknown`. Absence is the only answer
that may retire anything. Three shapes never produce it.

1. **V1 records no process.** `handoffCapsuleV1Schema` (`src/provider-proxy/handoff-capsule.ts`) declares
   no process fields at all — the pids arrive with `handoffCapsuleV2Schema` and the incarnations with
   `handoffCapsuleV3Schema` — so the decision is skipped before any observation is taken. A V1 carries no
   evidence of absence, which is not the same as evidence that something is present.
2. **A V2 whose pid was recycled.** V2 records pids and no incarnation, so the observer has nothing to compare
   and falls back to liveness, where `observeProcessLiveness` (`src/infra/node-process.ts`) reads a live
   stranger and an `EPERM` refusal alike as `alive`. Recycling is likeliest after exactly the event that made
   the recorded set absent — a host reboot — so the capsules this work exists for are the ones where a V2 is
   likeliest to read `alive`. It retains, which is the safe direction, and it never stops retaining.
3. **A role that answers `unknown` on every boot.** `unknown` is not a weaker `absent`, so one unobservable
   role retains the whole capsule (Principle 11). A later boot re-observes, but through the same reader and
   the same recorded fields, so a cause that stands produces the same answer for as long as it stands.
   Reaching `unknown` needs an errno that is neither `ESRCH` nor `EPERM`, or a reader that throws — which is
   why it is a predicate-shape member rather than a frequency claim.

Incarnation-first rescues V3 and only V3. A mismatching readable token is the one observation available here
that proves a recorded process is gone, and it is the only one a recycled pid cannot defeat.

## What G3 did, and what it did not claim

It retired the decidable capsules and said so in the type: `recordedProcessesAllAbsent` returns `false` for a
V1 before observing anything, and every retirement cites three `absent` observations of the exact recorded
`{ pid, incarnation }` tuples. V1 runtime behaviour is unchanged, and no part of this entry was discharged.

The mint that shipped with it was said to enlarge this population and then mostly empty it again. The claim is
kept here rather than edited away, because what does not re-derive is why it was wrong. As written: a
source-mode boot now mints its own `buildSetId`, a capsule's canonical filename hashes that id —
`providerPathIdentityHash` and `providerHandoffCapsulePath` (`src/infra/path/provider-proxy.ts`) — so every
capsule a previous source-mode boot left behind is now another build's, refused as `other-build` by
`classifyProviderProxySetInheritance` (`src/coordinator/services/provider-proxy-set/inheritance.ts`), and
those capsules are current-generation, so they carry incarnations and the new decision retires them.

**A source-mode boot cannot leave a handoff capsule behind, so that population is empty.** The only writer is
`writeHandoffCapsuleFile`, reached inside `createProviderProxySetAuthority`
(`src/coordinator/live/provider-proxy/set-authority.ts`), which is assembled from three already-established
role sessions. Establishing them starts at `spawnGuardian`
(`src/coordinator/live/provider-proxy/acquisition-steps.ts`), and `resolveBackendArtifact`
(`src/provider-proxy/role-spawn.ts`) resolves that child to the bundled `bridge/coral-backend.cjs` unless the
running entrypoint already carries that basename. `startProviderGuardianRole`
(`src/provider-proxy/role-main.ts`) consumes its bootstrap capsule as its first statement, and
`assertConsumingBuild` (`src/provider-proxy/bootstrap-capsule.ts`) refuses there in both fallback modes: a
build-set mismatch when the child is a healthy bundle, whose proven id is its own and never the coordinator's
minted one, and strict-identity-unavailable when the child is the same malformed bundle. The guardian exits
before it listens, `establishControl` never returns a set, and acquisition dies with no capsule byte written.

The residue argument below therefore rests on the population that does exist: capsules written by a **bundled**
build that is no longer the running one — a rollback, an upgrade, or a reinstall. Those carry a proven
`buildSetId` that is not this boot's, are refused at the same `other-build` branch, and at V3 carry the
incarnations the new decision needs, so retirement is justified for them without reference to the mint. The
mint neither enlarges nor shrinks that set; it only guarantees that a boot which cannot prove an identity never
claims one a second boot also claims. What survives here is this entry's three members, and only those.

Two further between-boot effects follow from the same mint, and both are intended. A boot without a strict
identity does not inherit an earlier run's proxy set: `redeem`
(`src/coordinator/services/provider-proxy-set/inheritance.ts`) refuses a durable provider-operation record
whose `buildSetId` differs and answers `not-bequeathed` before reading a capsule at all, so the abandoned set
is left to its own bounded enforcement and then to this retirement work. Stated as "no longer inherits _its
own_ previous run's set", this was the same vacuous claim as the one above — the sets such a boot refuses were
acquired by bundled builds. And an interrupted automatic store reset written by an earlier such boot no longer
resumes: `authorizeAutomaticIncidentResume`
(`src/store/backend-store-reset.ts`) compares the manifest's `buildSetId` against the running authority
and refuses as `store_reset_interrupted_authority_mismatch`. That refusal already names its exit, and the exit
is a command that exists rather than one this work would have to add — `interruptedStoreResetRemediation`
(`src/runtime/errors.ts`) prints `coral-cli backend store-reset discard --target gen2 --flavor <prod|dev>`.

## The correction this entry inherits, kept in place

The entry this narrows recorded a correction about its own residue argument, and it is carried here rather
than summarized because the correction is the part that does not re-derive.

An earlier revision of that argument claimed the foreign-capsule residue matched what stale V1 capsules
already cost. It was recorded as wrong when written, on the ground that a same-build V1 took a third path,
`capsule-opaque`, which consumed acquisition capacity, started redemption immediately and owned retry timers.

**That retraction does not hold either, and it fails the same way the source-mode population above does.** A
same-build V1 needs a writer whose `buildSetId` is this boot's. A capsule is always written at
`CURRENT_HANDOFF_CAPSULE_VERSION` (`src/provider-proxy/handoff-capsule.ts`), so a build carrying the opaque
path wrote V3 and could never meet a V1 of its own; and a writer matching the shared sentinel cannot produce a
capsule at all, for the reason walked above. So the expensive path had no population, and the residue claim it
was retracted for may have been right as first written.

What is certain is the part that does not depend on either argument: the path is gone, and a same-build V1 and
a same-build V2 are now refused as `unreadable-identity` by the same branch
(`classifyProviderProxySetInheritance`, `src/coordinator/services/provider-proxy-set/inheritance.ts`), so a V1 is classified exactly as a V2 is. Three
successive revisions of this one claim were each argued from a population nobody checked — that is the reason
this entry keeps all three rather than the latest.

G3 then split the two again, in the other direction, and that is the live form of the claim: a V2 or V3 is
observed and can leave, a V1 is skipped and cannot. The residue is now equal only across the members listed
above — a capsule whose absence stays undecidable. What each of them costs per boot is the credential on disk,
two alias-map entries, either a recovering claim or one non-capacity-consuming `capsule-foreign` slot, and one
warning per discovery. Observation is the one term that differs: a retained V2 pays up to three liveness
probes and a retained V3 up to six Darwin subprocess probes, both stopping at the first non-`absent` answer,
while a V1 pays none because the decision is skipped before observation. A foreign slot is excluded from the
admission count and from retained/excess classification
(`src/coordinator/services/provider-proxy-set/index.ts`), so none of it can deny service.

## Two prescriptions retired with the entry this narrows

Both were written as requirements and both were false by the time they were read. Recording that is the point:
a successor entry that carried them would have prescribed work nobody needed.

- **"`ProviderProxySetLifecycleDeps` has no process port; it would need one."** It does not, and G3 refused to
  add one. The observation crosses as an operation-scoped callback beside the capsule list, so lifecycle code
  holds no capability to spawn, exec, kill, or signal — "never signal a foreign pid" is true by construction
  instead of by convention. Any future work here inherits that constraint.
- **"The `capsule-foreign` slot keeps no capsule binding, so the slot grows a field."** The slot already
  carried `capsulePath` before the batch started, and no slot change was made. The claim was stale when
  written, not made stale by G3.

## Explicitly out of scope

The capsule format and the build gate. Adding process fields to V1 would be a format change, and a format
change cannot reach a capsule already written — which is the whole population this entry is about. The gate is
excluded for the opposite reason: it is now correct, because a boot that cannot prove an embedded identity
mints its own `buildSetId` instead of sharing one. And changing what `unknown` authorizes is excluded too —
retaining on `unknown` is not in question here, only what may end the retention.

## Start condition

A decision, not an inventory, and there is no observation to gather first. Absence is undecidable for these
three shapes, so closing the entry means naming what may end the hold when no evidence will: an age-based
retirement with a stated tolerance for deleting a live set's credential, an operator command that retires a
named path as an explicit authority override, or a documented acceptance that this residue is permanent and
bounded. Principle 11 requires that whichever is chosen names its own exit; the current honest state is the
third answer, recorded here, with the residue measured above.
