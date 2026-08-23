# A launch slot can be released into the wrong pool, and the release says nothing

**Observed in the field, 2026-08-23.** A coordinator reported two held launch slots while positively
asserting that nothing was running:

```
active     = 2                                                       (LaunchCoordinator pools)
activeJobs = 0
diagnostics.carriers = { coverage: "complete", liveJobs: 0, unknownJobs: 0, recoveryDefectJobs: 0 }
```

The carrier line is the reliable half and it says nothing was live: `liveJobs` and `unknownJobs` are both
zero, so no stored non-terminal job existed at all. `coverage: "complete"` means only that every stored
non-terminal job was mapped to an observation — it is a statement about mapping, not about liveness, and
`unknownJobs` is how that observer honestly reports a liveness it could not determine. Here there was
nothing to map and nothing unknown. Two `jobId` entries were nonetheless still in the pool maps, and no job
was running in any project.

## Why the count and the jobs disagree

`active` on `LaunchCoordinator` (`src/coordinator/live/admission.ts`) is the summed size of
`pools[*].active`, a `Map<jobId, { provider, owner }>`. Every provider job passes through it, so in normal
operation the number equals the live job count — three parallel jobs read as three. It diverges only when an
entry is never removed.

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

Which of two causes produced the observed pair. Either a release ran against the wrong pool, or no release
ran at all — five provider jobs died that day with `provider became unavailable`, and a death path with no
release would do it. The recorded evidence cannot separate them, because the release keeps no record either
way. Both need fixing regardless; only the first is visible in the code.

**Circumstantial support for the second.** A process census taken while the two slots were held found a
provider-proxy set (a guardian and two children) whose age matched, to the minute, the death of a job that
had ended with `provider became unavailable` — the proxy processes outlived the job that owned them. That is
consistent with a death path that released neither the containment nor the slot, but a matching age is not
proof of which code path ran.

Found in the same census: four orphaned coordinator processes from `clients/build/`, three hours old,
still holding `/tmp/coral-cli-test-*/…/coordinator.sock`. Those are a test-run cleanup leak rather than this
defect, and they belong to whatever owns test teardown; they are noted here only because one census surfaced
both and a reader chasing stray Coral processes will meet them together.

## Why it is not cosmetic

Slots are finite. `hasLaunchCapacity` admits only while `pools[pool].active.size` is below
`getActiveLimit(pool, env)` (`src/coordinator/live/worker-limits.ts`), after which launches queue, and past
`getMaxQueueSize` they are refused outright with `queue_full`. Leaked entries are never reclaimed by any
event, so the capacity lost is permanent for the life of the process: the only recovery is a coordinator
restart. That is a hold with no exit, which the same principle forbids.

## The operator cannot see which job

`getActiveJobIds(pool)` exists on `JobQueueReadPort` (`src/jobs/contracts/admission.ts`) but is not exposed
through `/health?detailed=1` or `backend status`, both of which publish only the count. Principle 11 asks
that a refusal be visible as durable status "keyed by the identity it can be acted on with"; a bare `2`
cannot be acted on. Exposing the held ids is the smallest part of this entry and the one that would have
answered the question above in seconds.

## Shape of the fix

Make the release say which of the three it did — freed a slot, found no such reservation, or could not
determine — and make the pool a required argument so a caller cannot omit it into the wrong map. Publish the
held ids as diagnostics. Whether a not-found release should also be reported as a defect through the carrier
observer is the open question. Note what the carrier observer is *not* guilty of: it reported zero live and
zero unknown, which was correct — the stale entries live in the launch coordinator's own maps, which that
observer does not read. Nothing in the carrier diagnostics could have revealed this, which is why exposing
`getActiveJobIds` matters rather than expecting an existing surface to have caught it.

## Start condition

Independent of `backend-routing-disposition`. Worth doing before that plan's PR3, since a leaked slot is
recovered only by restart and this was reached in ordinary use.
