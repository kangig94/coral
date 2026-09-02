# TODO — concurrent coordinator starts share one startup-error slot

**Status**: open and predates `fix/coordinator-socket-identity`. The branch made documented coordinator
startup refusals survive the child-process boundary, but the channel that carries them has room for one
attempt while startup permits more than one attempt to be in flight.

## What is wrong

Every coordinator child writes its serializable setup failure to the same `startupErrorFile`:
`coordinatorPaths` (`src/infra/path/coordinator.ts`) fixes that path at
`<runDir>/startup-error.json`. `writeStartupErrorSentinel`
(`src/coordinator/bootstrap-diagnostics.ts`) gives its temporary file the child pid and attempt id, then
renames that temporary file onto the shared path. The rename is atomic, but its destination is single-slot,
so a later child's complete sentinel replaces an earlier child's complete sentinel.

Each parent waits through `matchingStartupError` (`src/transport/ipc/ensure.ts`). Every read first crosses one
boundary check — the sentinel's socket path and flavor must be the ones this invocation wants. For a freshly
spawned child the parent then requires `resolveStartupAttemptLineage` (`src/infra/startup-attempt-lineage.ts`)
to return `proven-current-attempt` on the `startup-attempt-id` proof, which holds only when the sentinel's
`attemptId` and the id this parent gave that child are both canonical identifiers and equal, and requires the
file mtime not to precede the spawn by more than one poll interval. That mtime bound is a floor with no
ceiling: it excludes a sentinel written before this spawn, not one written after it. The attempt id is
therefore not the parent's only predicate, but it is the only predicate unique to that parent-child pair —
socket path, flavor, and a lower mtime bound are all shared by every concurrent same-installation attempt, so
such a sentinel passes them and fails only the attempt-id check.

The existing-starting reader has no attempt id to compare, so it substitutes this installation's bundle hash
and namespace. It compares `sentinel.pid` only when that polling iteration obtained an `observedPid` from
discovery or health. With neither available, it performs no pid comparison: any sentinel carrying that bundle
hash and namespace is accepted unless the process named by that sentinel is observed absent. The shared slot
can therefore lose one parent's diagnostic and can also attribute a concurrent coordinator's diagnostic to a
parent that never observed that coordinator's pid.

## Reachable scenario and consequence

Two top-level CLIs can both observe no serving coordinator and reach `spawnTopLevelCoordinator`; there is no
pre-spawn mutex, because the kernel socket bind remains the incumbent arbiter. Each spawn first clears the
same sentinel path, and each child receives a distinct random attempt id.

If both children fail with a documented setup error before either becomes ready, child B can rename its
sentinel over child A's before parent A polls the file. Parent A rejects B's sentinel because its attempt id
does not match, continues polling, and eventually reports `backend_unreachable`. The original documented
code, message, remediation, and exit class from child A are lost even though child A wrote them successfully.
Which parent loses its diagnostic depends only on the write and poll ordering.

## What it would take

Key startup-error sentinels by attempt id so one child cannot overwrite another child's report. The writer
already has the id, and a current-attempt parent already has the same id; both should address that attempt's
own file rather than a shared destination.

This also needs lifecycle work around the other reader shape. A parent waiting on an already-starting
incumbent has no attempt id. When it has an observed pid, a per-attempt layout could perform a bounded lookup
for that pid before using process liveness to decide whether it may clear the file. That is not a complete
design: when `observedPid` is undefined, a pid-keyed lookup has no safe selector and dropping that lookup
would discard the only structured startup diagnostic. The wait path must either retain enough identity from
the incumbent observation that led into it, or define how an ambiguous same-installation sentinel is
reported without attributing it to the wrong process. The layout also needs a retention rule that removes
abandoned attempt files without letting one parent erase another live attempt's evidence, and the
clear-before-spawn operation must become attempt-scoped.

## Start condition

First add a deterministic two-attempt lifecycle fixture that forces child A's write, child B's overwrite,
then parent A's read, and proves A receives `backend_unreachable` while B's sentinel occupies the shared
slot. Add the existing-starting case with no discovery record and no health response, where the current
reader has no observed pid and accepts a same-installation sentinel. The keyed layout, both
existing-starting dispositions, and stale-attempt cleanup should then ship together; fixing only the
current-attempt reader would leave unbounded files or lose diagnostics on the no-observed-pid path.
