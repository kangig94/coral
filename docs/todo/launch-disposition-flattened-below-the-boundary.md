# TODO — the launch boundary's third answer is flattened by the owners below it

**Status**: open, four independent members, each with its own start condition below. Members 1 and 2 were found
by a tier-1 panel on `fix/preflight-cannot-defer`; members 3 and 4 by two later panels on the same branch, and each
is a cause of the ones above it rather than a restatement. Left
out of that branch after a design pass ruled that neither is what §11 demands of *that* change: the launch
decision now carries `undetermined` in its own type, and what the members below do with it is each owner
withdrawing a promise it owns rather than finalizing on someone else's evidence. Both are pre-existing —
before the third answer existed, the same paths received `rejected` and did the same thing — so neither is a
regression, and each is a behaviour change that wants its own argument.

Neither is speculative. Member 1 is a field that already exists and that nothing reads; member 2 is a
boundary the CLI already distinguishes one command away.

## Member 1 — discuss mints participant records for a participant nobody ran

`executeAgentAttempt` (`src/discuss/shell/runtime-build.ts`) already draws the line correctly. A launch that
was refused or could not be established returns `AttemptFailure` with `consumedAttempt: false`, and a failure
after a job actually started returns `consumedAttempt: true`. To a discussion those first two are one
disposition — no job ran, nothing about the participant was observed — and the type says so.

Nothing reads it. `consumedAttempt` is written at eight sites in that file and appears nowhere else in `src/`.
Every flow branches on `isAttemptSuccess` alone and then writes a record characterizing the participant:

- `collectBidOutcome` (`src/discuss/shell/flow/bid.ts`) returns `failedBidOutcome` with
  `executionFailure: true` and `shouldExpel` for a required agent. `executionFailure` asserts the agent could
  not execute; nothing observed that. All-failed then ends the session `no_participants`.
- `collectSpeech` (`src/discuss/shell/flow/speech.ts`) reaches `decideSpeechTimeout`, which appends
  `speech.timed_out` — a transcript entry saying the speaker timed out without delivering a speech — and
  decrements the speaking quota. That transcript is rendered into every later participant's prompt, so the
  false record propagates into discussion content.
- `collectFollowUpAnswer` (`src/discuss/shell/flow/followup.ts`) returns `attempt.message`, and the caller
  commits it as `follow_up.answered`. The operator-facing diagnostic becomes the participant's answer.

The fix is to branch on the field that exists: an unconsumed failure is a system failure, and the exit it
should take already exists in `forceEndAfterLoopFailure` (`src/discuss/shell/loop.ts`), which ends the session
`{force: true, reason}` and characterizes nobody. `collectBidOutcomeSafely` must stop absorbing it into
`failedBidOutcome` first.

**Do not add a third `AttemptResult` arm.** A `held` variant beside an unread `consumedAttempt` would be two
vocabularies for one disposition. And a per-participant *skip* is not available without a real hold:
`decideBidRoundClose` returns `quorum_not_met`, `collectBids` runs again, and nothing re-drives an automatic
participant — `resumeLoop` is called only from `startDiscussSession`, `submitManualBid`, `submitManualSpeech`
and restart recovery. A hold there would be a discussion that never settles with an operator who cannot move
it, which is the defect §11 names rather than the fix for it.

Cost of the fix, and the reason it is not obviously right: one unconsumed failure would end the whole
discussion, where today it continues without the expelled participant.

## Member 2 — a workflow reports the same non-answer with a different exit than a job does

`handleWorkflowError` (`src/coordinator/services/workflow-execution.ts`) records every non-abort
`WorkflowExecutionError` as `lifecycleFault: { kind: 'wrapper_crashed' }` — a refused atom launch and an
undetermined one alike — and `toExitCode` (`src/cli/follow.ts`) returns `1` for any `failed` terminal. So a
preflight that established nothing exits `75` under `coral-cli codex` and `1` under `coral-cli workflow`, and
an operator scripting the second cannot tell "not established, retry" from "refused".

The fix is a `JobLifecycleFault` kind carrying the launch decision so the CLI can preserve the boundary the
launch decision already draws. That is a durable shape addition and owes §10 its usual obligations, which is
most of why it is here rather than in the branch.

## Member 3 — the discuss launch wrapper abandons a launch that can still commit a job

The wrapper's hand-rolled timeout is also tracked in
[`hand-rolled-timeout-latches.md`](./hand-rolled-timeout-latches.md); change its race and late-result
ownership together.

`withDiscussLaunchTimeout` (`src/discuss/shell/runtime-build.ts`) arms `DISCUSS_LAUNCH_TIMEOUT_MS` (30 s) when
it calls into the coordinator. The preflight budget `PROVIDER_PREFLIGHT_ANSWER_BUDGET_MS` (27 s) is armed
*inside* that call, after provider binding and agent resolution. The two are relative timers started at
different boundaries and nothing enforces their ordering: if the work before preflight takes more than the
3 s between them, the outer timer fires first. The wrapper then resolves `undetermined`, the attempt returns
`consumedAttempt: false`, and its `settled` latch discards whatever the launch returns afterwards — while
`JobLaunchService.start` goes on to `sessionManager.prepare` and commit a job whose id nobody holds. A retry
then meets `discussion_job_launch_conflict`.

This is §11's successor clause: local ownership was released with no successor named, and the abandoned work
can still produce the thing that was abandoned. It is pre-existing — the wrapper previously resolved
`{status:'rejected', code:'launch_failed'}` and discarded the same job — so the third answer did not create
it. Raised twice by independent panels on `fix/preflight-cannot-defer`; both times the branch was the wrong
place, because the fix is a cross-service change and not a message.

The two shapes worth weighing, neither obviously right:

- **One absolute deadline** threaded from discuss through the launch service, so the outer bound covers
  binding *and* preflight and the service guarantees no commit after it returns. An earlier design pass
  rejected this as structurally blocked and its reasons should be re-checked rather than inherited:
  `DiscussRuntimePorts.time` is a `Pick<TimePort, …>` without `monotonicNow`, and discuss reaches the
  coordinator through `CoordinatorSessionOps.start` rather than `ExecutionService.start`.
- **Delete the discuss race** and let the coordinator's budget be the only one. Cheaper and removes the
  second deadline entirely, but the wrapper is also what bounds a launch that hangs *before* preflight arms,
  so removing it needs that bound to exist somewhere else first.

A third option — adopt the late job id idempotently instead of discarding it — keeps both timers but makes
the wrapper's return a hand-off rather than an abandonment.

**The same missing contract, one layer down.** `runProviderPreflight`
(`src/coordinator/services/execution-policies.ts`) races the provider's probe against its own 27 s budget and
re-asks a returned `undetermined{cause:'provider'}` while budget remains — a `deadline` returns at once, precisely
because that probe may still be running — but it cannot cancel a probe and does not know how long
one takes to settle. A Codex probe names a 10 s timeout (`probeCodexAppServer`), and `buildExecPromise`
(`src/runtime/exec-builder.ts`) then adds SIGTERM and SIGKILL grace on top of it, so a probe started late in
the budget can still hold timers after the coordinator has returned `undetermined{deadline}` — and an
operator retrying immediately starts another beside it. Claude's detector carries the same fixed probe bound
(`createCliDetector`). Nothing here produces a wrong answer, which is why it is not a member: the answer is
honest and the budget is respected. What is missing is the same thing member 3 is missing — an absolute
deadline or a cancellation capability that crosses into the provider — so whoever takes that on should settle
both at once rather than adding a second mechanism.

## Member 4 — a capability probe runs in the requester's working directory

The deferred spawn-failure classification overlaps
[`process-port-answers-with-two-values.md`](./process-port-answers-with-two-values.md).

`buildCodexPreflightRuntime` (`src/providers/codex/execution-plan.ts`) builds `runExact` with
`cwd: input.cwd`, so every preflight probe spawns in the working directory the request named. Two of those
probes ask questions that have nothing to do with that directory: whether this Codex CLI supports
`app-server`, and whether a CLI can report its version. Running them there is what created the entire
ENOENT/EACCES ambiguity two commits spent resolving — a child `chdir`s before it execs, so the request's
directory can fail a probe about the binary, with an errno that names the command either way.

Those commits resolve the ambiguity **after** the fact, by observing the directory once the spawn has
already failed. That observation is of mutable state at a later instant, so a directory whose permissions
changed in between is attributed to the wrong cause, and Node offers no atomic failure-stage provenance to
close the race from here. The consequence is now bounded — only an answered probe may be cached, so a
mis-attribution costs one job its message rather than every job for the cache's lifetime — but the race
itself remains.

The root fix removes the ambiguity at its source rather than resolving it afterwards: a capability probe
should not run in the requester's directory at all. What has to be established first is whether either CLI
reads anything relative to `cwd` when answering `--version` or `app-server --help`; if neither does, the
probe can run somewhere this process controls and an ENOENT from it means the command, with no observation
and no race. The request's own directory still has to be validated, but that is a launch-time check with
its own message, not something a capability probe should be inferring.

## Also observed, not filed as members

`probeCodexAppServer` (`src/providers/codex/provider-facets.ts`) answers every non-zero exit of
`codex app-server --help` with the upgrade message, although a binary that starts and exits non-zero for a
configuration failure has established only that it could not answer. The refusal itself is right — a CLI
that cannot answer is unusable whatever the reason — and only the remedy over-claims. Separating "this
Codex has no app-server subcommand" from "this Codex could not get far enough to say" needs the exit-code
signature Codex actually uses, and `.claude/rules/conventions.md` requires citing what was measured and on
what, so this wants a measurement rather than a guess.

The generic detector's equivalent branch no longer over-claims: a non-zero version exit reports a failed
version check rather than an absent CLI.

## Start condition

Independent of each other, but 3 and 4 are the causes of what 1 and 2 report, so a fix that starts above
them will be a fix to a symptom.

- **Member 1** is discuss-owned and wants its ending decision agreed first — it changes when a discussion
  ends, not only what it records.
- **Member 2** needs the durable-shape decision that `build-identity-and-upgrade` is holding, since it adds
  a fault kind an older build will meet.
- **Member 3** needs one of its three shapes chosen before any code moves, and the first of them requires
  re-checking a claim this entry deliberately did not inherit: whether discuss can reach the launch service
  with an absolute deadline at all.
- **Member 4** starts with a measurement, not a change: whether `codex` or `claude` reads anything relative
  to `cwd` while answering `--version` or `app-server --help`. If neither does, the probe moves and the
  ambiguity member 3's race turns on stops existing; if either does, member 4 closes as won't-fix and
  member 3 carries the whole problem.
