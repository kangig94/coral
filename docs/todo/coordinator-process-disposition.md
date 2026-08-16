# TODO — process disposition is a recovery completion obligation

**Status**: open. Repairable provider-binding failures now quarantine without signalling or terminalizing, but
the recovery framework still cannot require process disposition before another path commits terminal facts.

## What exists

Coordinator recovery declares terminal and session-claim obligations. Process ownership is represented only by
a process-local cleanup callback. `src/recovery/containment.ts` commits the selected recovery disposition first
and runs that cleanup afterward (currently the sequence beginning at line 318).

That ordering is correct for releasing an in-memory `RecoveryRegistry` entry after a quarantine is durable. It
is not sufficient when cleanup means stopping an external process: a terminal job can already be committed when
the stop fails or when absence cannot be observed.

## Required shape

Add `coordinator-process-disposition` as a required completion obligation for every coordinator recovery path
that intends to terminalize a job with a runtime carrier. The path must:

1. contain or stop the exact process under valid signalling authority;
2. positively observe its absence;
3. satisfy the process-disposition obligation;
4. only then commit job terminal and session-claim-release facts.

If containment fails, liveness is unknown, or the carrier is not addressable without separate authority, the
path must return a durable quarantine before terminal facts are committed. Process-local cleanup remains only
for releasing in-memory ownership after the disposition commits.

## Explicitly out of scope

This pass does not redesign persisted-invalid binding recovery, add operator abandonment, or reorder the generic
containment engine. It removes the unsafe repairable-binding use of the old cleanup path and records the missing
obligation rather than pretending the wider invariant is already enforced.

## Start condition

Inventory every coordinator action that can terminalize a runtime-bearing job and every cleanup callback that
can signal. The obligation, settlement facts, and containment ordering must change together, with crash-cut tests
showing that no terminal fact is durable before process absence is durable evidence.
