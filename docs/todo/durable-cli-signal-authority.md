# TODO — the durable-CLI signal paths hold the evidence and do not read it

**Status**: open; three of five rows closed. Found on `refactor/process-incarnation-token` by the scan in
`tests/invariants/signal-authority.test.ts`, not by review — five reviewers read the same branch and none of
these four came up, which is most of the argument for the scan existing.

## What is already closed

`src/infra/process-supervision.ts`'s own `gracefulKillByPid` escalation is guarded: before sending SIGKILL it
re-reads the target's incarnation, refuses to escalate unless that reading still matches what SIGTERM was sent
to, and refuses outright unless the target is freshly observed `alive`. Its `tests/invariants/signal-authority.
test.ts` ALLOWLIST entry is gone because the file now consults `incarnationMayAuthorizeSignal` directly, which
is what let the scan stop naming it.

`src/coordinator/live/durable-transport.ts`'s three calls are closed the way "The shape of the fix" below
always said was preferable: `gracefulKillByPid` grew an optional `expectedIncarnation` parameter, and this
module's own captured `incarnation` — the same value it already hands `onDurableProcessIdentity` for
`durable_cli_process.v1` — is now passed to all three of its calls
(`gracefulKillByPid(runtime, durable.pid, incarnation ?? undefined)`). Where an incarnation can authorize a
signal at all (`incarnationMayAuthorizeSignal`), a fresh mismatch or an unreadable target now refuses the
first SIGTERM, not only the escalation after it. Where it cannot (Darwin), the gate is skipped rather than
turned into a blanket refusal: refusing there would regress every idle-timeout and abort kill this module
performs into a permanent no-op, a materially worse cost than the escalation-only limit
[`darwin-signal-authority.md`](./darwin-signal-authority.md) already accepts elsewhere, and nothing about this
fix asked the two documents to disagree about macOS. Its own ALLOWLIST entry is gone for the same mechanical
reason as the escalation's — every call in the file now reads `gracefulKillByPid(runtime, pid, …)`, none of
them spell `kill` literally, and `signalsABarePid`'s AST scan cannot see a call it never names.
`tests/invariants/signal-authority.test.ts`'s own "every exemption still signals a bare pid (stale entries are
removed)" check rejects an entry for this file today, which is the fact that decided fixing this now over
tracking it further.

`src/coordinator/services/recovery/actions.ts` now reads the `durable_cli_process.v1` identity beside the
recovered pid and passes its incarnation to `gracefulKillByPid`. A missing identity, a recorded pid mismatch,
or a fresh incarnation mismatch refuses the signal. Its recovery-binding-failure path retains the recovery
registry and a durable, operator-retryable quarantine until provider adoption succeeds or the recorded process
is observed absent; a signal request alone no longer authorizes settlement.

## What exists now

Signals aimed at a pid that came out of a durable record, with no check that the pid still names the process
the record was written for. Note the two columns are different things and the difference matters:

| Module (what the invariant names)              | Signal paths inside it                                             |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `src/coordinator/services/recovery/service.ts` | one direct `kill`, in the abort handler for an **adopted** job       |
| `src/jobs/reconcile/registry.ts`               | one direct `kill`, in the abort handler for a live job               |

`tests/invariants/signal-authority.test.ts` is a **module**-level scan, and a helper-delivered signal is
attributed to the helper's file rather than the caller's. That is why closing `recovery/actions.ts` removed no
ALLOWLIST entry: the behavior needed its own review and test. Treat the ALLOWLIST as a checklist of modules
and this table as the checklist of behaviours; neither is a substitute for the other.

The `recovery/service.ts` row is the sharpest. Adoption exists precisely because the record outlived the
process that wrote it, so its pid has already survived one process boundary before anyone signals it.

## Why this is a defect and not a nit

The identity **is recorded**. `durable_cli_process.v1` (`src/jobs/runtime-meta.ts`) carries an
`incarnation` beside the pid, and `observeProcessIdentity` already exists to compare one. The remaining sites
simply do not ask. That is a different situation from
[`darwin-signal-authority.md`](./darwin-signal-authority.md), where the evidence is too weak to use — here it
is sitting in the same record as the number being signalled.

The window is not narrow, either. An abort that can arrive at any time, and — for `service.ts` specifically —
a pid that already outlived one process boundary before adoption, are exactly the shapes where a child exits,
its pid is recycled, and the signal lands on a stranger.

## What is already true, and must not be re-derived

`durable_cli_process.v1` did **not** need a generation move when the incarnation replaced
`processStartedAtSeconds`, and this was checked rather than assumed:
`decodeDurableCliProcessRuntimeMeta` in v0.10.8 returns `null` on any decode failure, so a rolled-back build
reads the new shape as "no recorded identity" and answers `unknown`. That is Principle 10's second mechanism
working as intended. Do not "fix" it by renaming the key — the saga record needed that
(see the commit that moved `provider_operation_saga`) because _its_ shipped reader was strict.

## The shape of the fix

Read the recorded incarnation next to the pid, probe, compare, and refuse on mismatch — the same three lines
`verifySignalTarget` already runs. `gracefulKillByPid` (`src/infra/process-supervision.ts`) took the first
option this section used to pose as a choice: it now takes an optional `expectedIncarnation`, gating the first
SIGTERM the same way its escalation was already gated, and a caller that omits it keeps the prior unguarded
behaviour. `durable-transport.ts` and `recovery/actions.ts` supply one.

What is still undecided is **what refusal means to an abort**. A user pressing abort expects the job to stop.
If the identity no longer matches, the process is already gone and the abort has trivially succeeded — but the
job's terminal state must still be written, so refusing to signal cannot mean returning early from the abort.
`service.ts` and `registry.ts` signal a bare pid directly rather than through `gracefulKillByPid`, so closing
either means either routing it through that helper with a recorded identity, or repeating the same
read-probe-compare-refuse shape locally.

On macOS this interacts with [`darwin-signal-authority.md`](./darwin-signal-authority.md): a matching
incarnation there is not proof, so whichever of these sites closes next gains `incarnationMayAuthorizeSignal`
at the same time and inherits the same trade `durable-transport.ts` and the escalation already made — skip
the extra check rather than convert it into a blanket refusal. Unlike the containment path, refusing here
leaks nothing the user cannot see — the job stays visible and its child is reclaimed by whatever ends it
normally.

## Start condition

None. The evidence exists, the comparison exists, and `gracefulKillByPid` now carries it end to end for one
caller. The smallest unit of progress is one **behaviour** from the table above, not one ALLOWLIST entry — a
module's entry may only be deleted once every path inside it is guarded, exactly as `durable-transport.ts`'s
was. The test that pins each: a recorded identity whose probe returns a _different_ incarnation, asserting no
signal is sent and the job still reaches its terminal state —
`tests/unit/infra/process-supervision.test.ts`'s `gracefulKillByPid` cases are that test for the helper itself;
each remaining row still needs its own.
