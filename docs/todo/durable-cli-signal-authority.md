# TODO — four durable-CLI signal paths hold the evidence and do not read it

**Status**: open. Found on `fix/workflow-replacement-cleanup-envelope` by the scan in
`tests/invariants/signal-authority.test.ts`, not by review — five reviewers read the same branch and none of
these four came up, which is most of the argument for the scan existing.

## What exists now

Four call sites signal a pid that came out of a durable record, with no check that the pid still names the
process the record was written for:

| Site                                                     | When it fires                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------- |
| `src/coordinator/live/durable-transport.ts`              | a durable child idles past `IDLE_TIMEOUT` — **minutes** later |
| `src/jobs/reconcile/registry.ts`                         | the user aborts a job, arbitrarily long after launch          |
| `src/coordinator/services/recovery/service.ts`           | an adopted job is aborted **after a coordinator restart**     |
| `src/infra/process-supervision.ts` (`gracefulKillByPid`) | the generic pid-based escalation the others resemble          |

The third is the sharpest. Adoption exists precisely because the record outlived the process that wrote it, so
the pid has already survived one process boundary before anyone signals it.

## Why this is a defect and not a nit

The identity **is recorded**. `durable_cli_process.v1` (`src/jobs/runtime-meta.ts`) carries an
`incarnation` beside the pid, and `observeProcessIdentity` already exists to compare one. These four sites
simply do not ask. That is a different situation from
[`darwin-signal-authority.md`](./darwin-signal-authority.md), where the evidence is too weak to use — here it
is sitting in the same record as the number being signalled.

The window is not narrow, either. An idle timeout measured in minutes and an abort that can arrive at any time
are exactly the shapes where a child exits, its pid is recycled, and the signal lands on a stranger.

## What is already true, and must not be re-derived

`durable_cli_process.v1` did **not** need a generation move when the incarnation replaced
`processStartedAtSeconds`, and this was checked rather than assumed:
`decodeDurableCliProcessRuntimeMeta` in v0.10.8 returns `null` on any decode failure, so a rolled-back build
reads the new shape as "no recorded identity" and answers `unknown`. That is Principle 10's second mechanism
working as intended. Do not "fix" it by renaming the key — the saga record needed that
(see the commit that moved `provider_operation_saga`) because _its_ shipped reader was strict.

## The shape of the fix

Read the recorded incarnation next to the pid, probe, compare, and refuse on mismatch — the same three lines
`verifySignalTarget` already runs. Two things to decide while doing it:

1. **`gracefulKillByPid` has no record at all.** It takes a number. Either it grows a
   `RecordedProcessIdentity` parameter, and its callers supply one, or it stays the deliberate escape hatch
   with the check pushed to each caller. Prefer the first: an escape hatch that is easier to call than the safe
   path is how these four happened.
2. **What refusal means to an abort.** A user pressing abort expects the job to stop. If the identity no
   longer matches, the process is already gone and the abort has trivially succeeded — but the job's terminal
   state must still be written, so refusing to signal cannot mean returning early from the abort.

On macOS this interacts with [`darwin-signal-authority.md`](./darwin-signal-authority.md): a matching
incarnation there is not proof, so these sites gain `incarnationMayAuthorizeSignal` at the same time and
inherit the same trade. Unlike the containment path, refusing here leaks nothing the user cannot see — the job
stays visible and its child is reclaimed by whatever ends it normally.

## Start condition

None. The evidence exists, the comparison exists, and
`tests/invariants/signal-authority.test.ts`'s ALLOWLIST names all four; closing one means deleting its entry,
which is the smallest possible unit of progress here. The test that pins each: a recorded identity whose probe
returns a _different_ incarnation, asserting no signal is sent and the job still reaches its terminal state.
