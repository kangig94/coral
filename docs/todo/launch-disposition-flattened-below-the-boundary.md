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

## Start condition

Independent. Member 1 is discuss-owned and wants its ending decision agreed first — it changes when a
discussion ends, not only what it records. Member 2 needs the durable-shape decision that
`build-identity-and-upgrade` is holding, since it adds a fault kind an older build will meet.
