# TODO — process disposition is a recovery completion obligation

**Status**: open. A repairable provider-binding failure still terminalizes a job whose carrier may be
alive, and the quarantine that was written to stop it was taken back out by `42b8a559` — because a
quarantine that releases the job's only owner is not an improvement on terminalizing it.

## What exists

Coordinator recovery declares terminal and session-claim obligations. Process ownership is represented
only by a process-local cleanup callback. `src/recovery/containment.ts` commits the selected recovery
disposition first and runs that cleanup afterward.

`registerRunningRecovery` (`src/coordinator/services/recovery/actions.ts`) settles a binding failure
regardless of what the carrier is doing, and the comment there now says plainly that it is a known gap:
`profile-unavailable`, `identity-unavailable` and `subject-mismatch` are operator-repairable — their own
user-facing guidance is to restore a profile and retry — so the retry that this path denies would in
fact find something new. Three-valued liveness governs only what happens to the process: `alive` gets
the pid-kill cleanup, `absent` needs nothing, `unknown` is reported and never signalled.

## Why the first attempt was reverted, and what it teaches

`0e59ac52` classified those three failures as operator-repairable and returned a durable quarantine
instead of settling. The disposition was right and the ownership was not: recovery registers a
PID-backed abort handler, returns `quarantine`, containment persists it, and boundary cleanup then
**unconditionally removes the `RecoveryRegistry` entry**. The result is a job that stays `running`, a
carrier that is still alive, and no owner anywhere — `jobs abort` cannot reach the process. The test
written alongside it asserted the registry entry was absent, so the bug was encoded rather than caught.

The rule that would have caught it did not exist and now does, in Principle 11:

> A boundary may release local ownership of a still-live or not-proven-absent obligation only after the
> returned disposition names a successor owner and the boundary verifies that owner accepted the
> obligation; quarantine, retry, logging, and durable status are not ownership transfers.

## Required shape

Two halves, and they ship together because either alone is worse than the gap.

**Custody transfer.** A live-carrier quarantine returns an explicit retention in its disposition —
conceptually `retained: [{ obligation: 'carrier-custody', owner: 'coordinator-recovery-registry',
authorityRef, receipt }]`. The receipt is issued by `RecoveryRegistry` **only after** it verifies that
the exact job is registered, the exact durable runtime record is retained, and a usable abort capability
exists. Containment validates that receipt and skips the provisional cleanup for that obligation;
an ordinary quarantine with no live carrier still runs the existing cleanup unchanged.

`RecoveryRegistry.abort()` (`src/jobs/reconcile/registry.ts`) must also stop dropping custody the moment
it delivers SIGTERM. It marks cancellation and retains ownership until absence is observed or custody
transfers to the death/finalization poller — otherwise the same hole reopens one command later.

**The wider obligation.** Add `coordinator-process-disposition` as a required completion obligation for
every coordinator recovery path that intends to terminalize a job with a runtime carrier: contain or
stop the exact process under valid signalling authority, positively observe its absence, satisfy the
obligation, and only then commit job-terminal and session-claim-release facts. If containment fails,
liveness is unknown, or the carrier is not addressable without separate authority, the path returns a
durable quarantine before any terminal fact is committed. Process-local cleanup returns to what it is
good for: releasing in-memory ownership after the disposition commits.

## The proof

Behavioural, not structural: with a repairable binding failure quarantined and its carrier alive,
`jobs abort` through `coordinator/composition/job-control.ts` must find the job and deliver SIGTERM to
the retained pid. A companion containment test must show that an ordinary quarantine still invokes
cleanup, and a mutation that drops the returned receipt must make containment reject the disposition
because a live obligation has neither discharge nor verified transfer.

## Explicitly out of scope

Redesigning persisted-invalid binding recovery, operator abandonment of provider-operation evidence
(that is [`provider-operation-admission-hold.md`](./provider-operation-admission-hold.md)), and
reordering the generic containment engine beyond what the receipt requires.

## Start condition

Inventory every coordinator action that can terminalize a runtime-bearing job and every cleanup callback
that can signal. The obligation, the settlement facts, and the containment ordering change together,
with crash-cut tests showing that no terminal fact is durable before process absence is.
