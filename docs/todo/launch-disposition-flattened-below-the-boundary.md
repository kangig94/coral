# TODO — the launch boundary's third answer is flattened by the owners below it

**Status**: open, two independent members. Found by a tier-1 panel on `fix/preflight-cannot-defer` and left
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
starts a re-ask whenever any positive budget remains, but it cannot cancel a probe and does not know how long
one takes to settle. A Codex probe names a 10 s timeout (`probeCodexAppServer`), and `buildExecPromise`
(`src/runtime/exec-builder.ts`) then adds SIGTERM and SIGKILL grace on top of it, so a probe started late in
the budget can still hold timers after the coordinator has returned `undetermined{deadline}` — and an
operator retrying immediately starts another beside it. Claude's detector carries the same fixed probe bound
(`createCliDetector`). Nothing here produces a wrong answer, which is why it is not a member: the answer is
honest and the budget is respected. What is missing is the same thing member 3 is missing — an absolute
deadline or a cancellation capability that crosses into the provider — so whoever takes that on should settle
both at once rather than adding a second mechanism.

## Also observed, not filed as members

The `answered` non-zero branches of `probeCodexAppServer` (`src/providers/codex/provider-facets.ts`) and
`queryCliVersion` (`src/providers/cli-detection.ts`) still answer every non-zero exit with one message —
"upgrade Codex" and "install Claude" respectively — although a binary that starts and exits non-zero for a
configuration failure has established only that it could not answer. The refusal itself is right in both
cases: a CLI that cannot report its version is unusable whatever the reason. Only the remedy over-claims.
Correcting it needs measured exit-code signatures for both CLIs, and `.claude/rules/conventions.md` requires
citing what was measured and on what — so this wants a measurement, not a guess, and is recorded here rather
than fixed from inference.

## Start condition

Independent. Member 1 is discuss-owned and wants its ending decision agreed first — it changes when a
discussion ends, not only what it records. Member 2 needs the durable-shape decision that
`build-identity-and-upgrade` is holding, since it adds a fault kind an older build will meet.
