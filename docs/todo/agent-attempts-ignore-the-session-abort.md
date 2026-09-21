# A discuss agent attempt launches a job without checking the session's abort signal

**Status**: open. Found by `coral:architect` while reviewing the fix for the
`runFollowUpTurns` spin, 2026-09-19. Not reproduced from a test.

## What is true

`executeAgentAttempt` (`src/discuss/shell/runtime-build.ts`) never reads the live controller's abort
signal. The module contains no occurrence of `aborted` at all. It guards on the snapshot — returning
`Discuss session not found` when `loadAttachedOrPersistedSnapshot` yields nothing — and on the live
phase of an already-recorded job, and then launches through `ctx.service.start` or `ctx.service.resume`.

An abort does not remove the snapshot. `clearAllDiscuss` (`src/discuss/shell/live-registry.ts`) aborts
every controller before persisting any marker, so between the abort and the marker landing the snapshot
is still loadable and every one of those guards passes.

## Why it is bounded, and why it is still worth an entry

Until the same round's fix, this was unbounded: `runFollowUpTurns` (`src/discuss/shell/flow/followup.ts`)
tolerated a commit refusal by falling through to the top of its `while (true)`, so an aborted session
re-collected the same queue item and re-launched forever. That loop now returns on a refusal, so the
exposure is **one launch per draining session** — the suspended loop wakes, collects one answer, commits,
is refused, and exits.

One launch is small, and it is the reason this is an entry rather than a fix. But it is still a job
dispatched into a coordinator that is draining, spending admission budget that the drain is trying to
settle, which is the shape of the wedge in #357. The job's result also cannot land: `commitDecision`
(`src/discuss/shell/persistence.ts`) refuses it with `session_shutting_down`. So the work is launched,
paid for, and discarded.

## What a fix has to decide

Not "add a signal check" — where. The signal is the live controller's, and `executeAgentAttempt` receives
`ctx` and a session id rather than a controller, so reaching it means deciding whether the abort is part
of this function's precondition or the caller's. Note that the snapshot guard it already has is the same
question answered once for a different disposition, and principle 11 asks that the two not collapse into
one value: a session that is gone and a session that is draining are different answers, and the callers
of `AttemptResult` currently see both as `ok: false` with a message.

Worth checking while there: whether a job already launched and in flight when the abort arrives has any
disposition at all, or whether it simply runs to completion against a session nobody will read.
