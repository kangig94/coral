# A launch slot can be released into the wrong pool, and the release says nothing

**One-time field measurement, 2026-08-23, on host `KANG-HOME`.** A coordinator reported two active launch
entries while the persisted-job and carrier diagnostics reported no active jobs:

```
active     = 2                                                       (LaunchCoordinator pools)
activeJobs = 0
diagnostics.carriers = { coverage: "complete", liveJobs: 0, unknownJobs: 0, recoveryDefectJobs: 0 }
```

This live process state is gone and cannot be re-run as a fixture; the values above are the retained incident
measurement. The carrier line establishes that no stored non-terminal job was observed: `liveJobs` and
`unknownJobs` are both zero. `coverage: "complete"` means only that every stored
non-terminal job was mapped to an observation — it is a statement about mapping, not about liveness, and
`unknownJobs` is how that observer honestly reports a liveness it could not determine. Here there was
nothing to map and nothing unknown. It does not classify entries held for internal permits, and the diagnostic
did not expose the two active ids or their owners.

## Why the count and the jobs disagree

`active` on `LaunchCoordinator` (`src/coordinator/live/admission.ts`) is the summed size of
`pools[*].active`, a `Map<jobId, { provider, owner }>`. It is not a persisted-job count.
`reserveInternalPermitOrThrow` in `src/coordinator/live/admission.ts` inserts a `spawndurable-*` entry owned by
a `system-task` before and without a persisted job. `active > activeJobs` is therefore legitimate and
transient during a durable spawn. The observed `active = 2 / activeJobs = 0` requires inspecting the held ids
and owners; by itself it proves neither a leak nor a wrong-pool release.

## The line that makes a leak invisible

```ts
releaseLaunch(jobId: string, pool: LaunchPool = 'default'): void {
  const activeLaunches = this.getActiveMap(pool);
  if (!activeLaunches.delete(jobId)) return;
  this.admitQueueHead(pool);
```

A release whose `delete` finds nothing returns through the same path as a release that freed a slot. "I
released it" and "it was not in this pool" are the same outcome, recorded nowhere. That is principle 11 in
`.claude/rules/design-philosophy.md`: the third answer has no representation, and the caller cannot act on
what it cannot distinguish.

The default argument compounds it. `pool` defaults to `'default'`, but slots are held in whichever of
`default | discuss | curate` admitted the job. A release that omits the pool for a `discuss` or `curate` job
deletes from the wrong map, finds nothing, returns silently, and leaves the real slot held forever. The
default value is what turns a caller's omission into a silent leak instead of a type error.

## Not yet established

Whether either release defect produced the observed pair. The first step is to rule out internal permits by
inspecting the active ids and owners. If neither entry was an internal permit, then either a release ran
against the wrong pool or no release ran at all. The incident history retained on `KANG-HOME` contained five
provider jobs ending that day with `provider became unavailable`, so a death path with no release remains a
candidate, but that one-time count does not identify which path ran. The observation proves neither cause;
the silent no-op and defaulted pool remain independently visible defects in `releaseLaunch`.

**Circumstantial support for the second.** The same one-time process census on `KANG-HOME`, taken while the
two entries were held, found one provider-proxy set consisting of a guardian and two children whose displayed
start minute matched the recorded end minute of a job that had ended with `provider became unavailable`.
That is consistent with a death path that released neither the containment nor the slot, but minute-level age
agreement is not proof of which code path ran.

That census also counted four orphaned coordinator processes from `clients/build/`, each with a displayed age
of about three hours and still holding `/tmp/coral-cli-test-*/…/coordinator.sock`. Those one-time measurements
are not reproducible now. They indicate a test-run cleanup leak rather than this defect and are noted only
because the same census surfaced both.

## Why it is not cosmetic

Slots are finite. `hasLaunchCapacity` admits only while `pools[pool].active.size` is below
`getActiveLimit(pool, env)` (`src/coordinator/live/worker-limits.ts`), after which launches queue, and past
`getMaxQueueSize` they are refused outright with `queue_full`. An entry that is in fact leaked is never
reclaimed by any event, so the capacity lost is permanent for the life of the process: the only recovery is a
coordinator restart. That is a hold with no exit, which the same principle forbids. The field counts above do
not establish that either entry reached this state.

## The operator cannot see which job

`getActiveJobIds` on `JobQueueReadPort` (`src/jobs/contracts/admission.ts`) exists but is not exposed through
`/health?detailed=1` or `backend status`, both of which publish only the count. Principle 11 asks that a
refusal be visible as durable status "keyed by the identity it can be acted on with"; a bare `2` cannot be
acted on. Exposing the held ids is the first step: a `spawndurable-*` identity would rule an internal permit
in or out, and owner diagnostics would distinguish it decisively. That is the argument for exposing
`getActiveJobIds`, not a claim that the field count already proves a leak.

## Shape of the fix

Make the release say which of the three it did — freed a slot, found no such reservation, or could not
determine — and make the pool a required argument so a caller cannot omit it into the wrong map. Publish the
held ids as diagnostics. Whether a not-found release should also be reported as a defect through the carrier
observer is the open question. Note what the carrier observer is *not* guilty of: it correctly reported zero
live and zero unknown persisted jobs, but it does not inspect the launch coordinator's internal-permit or job
reservations. Nothing in the carrier diagnostics could classify the two active entries, which is why exposing
`getActiveJobIds` and ownership matters rather than expecting an existing surface to have caught it.

## Start condition

Independent of `backend-routing-disposition`. Worth doing before that plan's PR3, since a leaked slot is
recovered only by restart and this was reached in ordinary use.
