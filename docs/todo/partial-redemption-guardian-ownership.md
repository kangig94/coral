# TODO — a downstream role's teardown-latched refusal during redemption discards the guardian session that answered it

**Status**: open, found 2026-09-03 while checking `overload-tolerance-floor`'s AC3/AC7 against source. Not
implemented; the plan text specifies it (quoted below) and Phase 6's own test list names the outcome
("partial-session ownership outcome", "partial-redemption guardian ownership") as something to cover, but no
mechanism for it exists in the six landed commits and no test references it.

## What exists

`redeemProviderProxyControl` (`src/coordinator/live/provider-proxy/control-redemption.ts:206`) opens guardian,
then reaper, then proxy control in sequence, starting each role's heartbeat as soon as its session is
established. Any `ProviderProxyRoleControlRemoteError` thrown at any stage of any role — including a reaper or
proxy stage reached only after the guardian's own open-and-heartbeat sequence fully succeeded — is caught by
one handler (`control-redemption.ts:330-341`) that calls `abandonAttempt(heartbeatAssembly, opened)`
(`control-redemption.ts:182-186`, stopping every started heartbeat and closing every opened client, guardian
included) and returns a single flat shape: `{ kind: 'refused', refusal: { kind: 'role-refused', error } }`. The
`error` it carries is the `ProviderProxyRoleControlRemoteError` itself (`role`, `stage`, `method`,
`remoteFailure`); no client, session, or heartbeat/fault ownership survives the return.

Downstream, `#awaitControlReattachmentAbsence` (`src/coordinator/services/provider-proxy-set/index.ts:2377`)
receives that refusal and calls `decisiveTeardownLatchedRefusal` (`index.ts:666-679`), which recognizes exactly
one shape as decisive: `refusal.kind === 'role-refused'`, `error.stage === 'heartbeat'`, and
`remoteFailure.heartbeatRefusal?.reason === 'teardown-latched'` — i.e. a role's *first heartbeat inside
`establishRoleControl`* was refused after its own open call already succeeded. When that matches,
`#commitReattachmentTeardownLatched` (`index.ts:2426-2447`) issues `action: 'stop-and-reap'` through
`#beginFaultContainment` → `#commitContainmentThenBegin` → `#runContainmentAttempt`, which sends the guardian
commit over `slot.authority.commitContainment` (`index.ts:3391`, `set-authority.ts:452-503`) — the
**pre-reattachment** authority whose control channel is what triggered this reattachment window in the first
place, not the session `redeemProviderProxyControl` just verified and then closed. Every other refusal shape —
including `admissionReason === 'teardown-latched'` on the redeem/rotate RPC itself (`stage === 'open'`, which
`decisiveTeardownLatchedRefusal` does not check at all) — falls straight to the generic path:
`#enterReattachmentHold` while live claims remain, or `#beginContainment` with `await-containment-absence` at
zero claims (`index.ts:2389-2416`).

## What is missing

AC3 of the `overload-tolerance-floor` plan, under "Explicit containment is a tenancy-bound command, not a close
interpretation":

> `redeemProviderProxyControl` adds an ownership-transferring partial outcome used only when guardian control
> was successfully established and a later reaper/proxy answer is the exact structured `teardown-latched`
> refusal. That outcome carries the verified active guardian session, its heartbeat/fault ownership, and the
> refusal; `#runControlReattachmentAttempt` adopts the session and may issue the gated guardian commit. All
> other partial failures retain today's close-all cleanup. If the guardian itself answers `teardown-latched`,
> no active guardian session exists to transfer and no second commit is needed: the lifecycle enters
> containment-outcome observation and waits for the already-latched guardian/containment to become absent.

None of this exists. `ProviderProxyControlRedemptionOutcome` (`control-redemption.ts:79-87`) has no variant
carrying a partial guardian session; `redeemProviderProxyControl`'s catch block does not distinguish which role
or stage produced the error before calling `abandonAttempt`; and `decisiveTeardownLatchedRefusal` distinguishes
neither "guardian succeeded, a later role refused" from "the guardian itself refused" nor `stage === 'open'`
refusals from `stage === 'heartbeat'` ones. `commitContainment` itself (`set-authority.ts:452`) is a flat
single-shot request/reply over one fixed `guardianClient` with three outcomes
(`containment-absent | not-sent | outcome-unknown`) and no parameter for a caller-supplied session — there is
nowhere to hand it the adopted guardian client even if one reached this far.

## Consequence — what actually happens today

Independent absence proof (`sourceId: 'absence'`, `producerId: 'containment-proof'`) is unconditional: both
`#runControlReattachmentAttempt` and its restrained-cadence sibling `#runReattachmentHoldAttempt` start it on
every attempt regardless of what the redemption source returns, and it is what ultimately reaps an orphaned set
once the process-level containment prover observes both enforcers absent. That path does not depend on
anything below, so a set is never left destroyed on unproven evidence, nor stranded past the point where
absence could be proven, by this gap. What the gap actually costs is the accelerated path AC3 specifies:

- A guardian control session that just proved itself live and reachable — open call succeeded, first
  heartbeat accepted — is unconditionally closed by `abandonAttempt` the moment a *later* role in the same
  redemption attempt refuses, for any reason, decisive or not.
- For the one sub-case `decisiveTeardownLatchedRefusal` does recognize (a downstream role's own first
  heartbeat refused with `teardown-latched`), the coordinator still attempts `commitContainment`, but over the
  stale pre-reattachment authority rather than the session that just answered. That channel is the one whose
  loss opened this reattachment window, so the attempt is not expected to succeed; `commitContainment`'s own
  handling of a locally-unsent exchange (`not-sent`) or an unconfirmed one (`outcome-unknown`) means the
  wasted attempt changes nothing about the eventual outcome, only adds a round trip before falling through to
  the same independent-absence wait.
- A downstream role's `admissionReason === 'teardown-latched'` refusal at `stage: 'open'` (the redeem/rotate
  RPC itself refused, before any heartbeat is attempted) is not recognized as decisive at all and receives no
  special handling — same fallback, one fewer wasted round trip than the case above.
- If the *guardian's own* redemption fails with `teardown-latched` at its `heartbeat` stage,
  `decisiveTeardownLatchedRefusal` still matches (it does not check which role answered) and the coordinator
  still attempts a commit against a guardian that has already told it teardown is latched, rather than
  recognizing that no second commit is needed and entering containment-outcome observation directly.

None of this produces an incorrect final disposition: every branch converges on the same conservative
independent-absence wait that was always the backstop. The cost is exclusively speed and a discarded
connection — this is a suboptimal implementation of a specified fast path, not a correctness defect.

## What a fix must decide

- Where the ownership-transferring outcome lives in `ProviderProxyControlRedemptionOutcome` — a new `kind`
  carrying the established guardian `ControlClient`, its heartbeat/fault ownership, and the refusal that ended
  the attempt at the later role.
- How the catch block in `redeemProviderProxyControl` tells "guardian already fully established, then reaper or
  proxy refused with the exact `teardown-latched` shape" (both `stage: 'open'`'s `admissionReason` and
  `stage: 'heartbeat'`'s `heartbeatRefusal`) apart from every other refusal, so only that case skips closing
  the guardian session inside `abandonAttempt`.
- How the guardian's *own* `teardown-latched` refusal is told apart from a downstream one, so it can route
  directly to containment-outcome observation instead of through `#commitReattachmentTeardownLatched`'s commit
  attempt.
- How `#runControlReattachmentAttempt` consumes the adopted session to run the gated `guardian.containment-commit.v1`
  over the live channel instead of `slot.authority.commitContainment`'s pre-reattachment one, and who closes
  that session afterward — `#promoteControlReattachment` is today the only path that adopts a
  `RedeemedProviderProxyControl` into `slot.authority`, and a partial bundle carrying only the guardian is a
  different shape than what it expects.

## Start condition

Met; the plan already specifies the target shape (quoted above) and names its test
("partial-session ownership outcome", "every AC7 lifecycle exit"). This is a build-it task, not a design one.

## Interacts with

- `wedged-coordinator-self-drain` — a coordinator that never reaches this path at all (starved before any
  redemption attempt runs) still relies on the same independent-absence backstop this gap falls back to; that
  entry's "deliberate wedge" framing already assumes destruction proceeds only through that backstop or a
  named exit, which is exactly what happens here today, only slower than intended.
