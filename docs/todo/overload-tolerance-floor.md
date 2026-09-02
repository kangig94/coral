# TODO — a coordinator starved for 60 seconds must not have its work reaped

**Status**: open, and the requirement is settled while the mechanism is not. **Observed 2026-09-01 and
2026-09-02** on a host running several Claude Code sessions at once. The requirement, stated by the user
on 2026-09-02: **however it is achieved, a machine under load must survive 60 seconds of coordinator
starvation without killing work.** Multi-session use with concurrent builds is ordinary, not abuse.

## What was measured

The coordinator's own lateness instrumentation, across `coordinator.log` and `coordinator.log.1`:

| scheduler lateness | count |
| --- | --- |
| under 1 s | 15,014 |
| 1–5 s | 1,917 |
| 5 s and over | 46 |

Worst single stall 67,945 ms. Every `stop-and-reap` in both logs followed a stall, within seconds:

```
05:25:43.711Z  woke 15611ms after its requested time
05:25:45.488Z  stop-and-reap reason=provider_authority_lost fault=heartbeat-failed liveClaims=1  (x3)
04:14:51.633Z  woke 40097ms after its requested time
04:14:51.634Z  stop-and-reap reason=provider_authority_lost fault=control-channel-fault  (x2)
```

25 reaps in total, 13 `heartbeat-failed` and 12 `control-channel-fault`. Each carried `liveClaims`, and
each live claim was a delegated job that was healthy and was killed by the policy rather than by any fault
of its own. `provider-operation-reconciler.ts` then terminalizes them with `code: 'provider_lost'` and the
sentence the operator sees: "The provider became unavailable, so this job stopped before completion."

## What is already fixed, so nobody fixes it twice

The logs above are the **released 0.10.9 build**, not this source tree. Their `fault=heartbeat-failed`
lines carry `error=reaper.heartbeat.v1 exceeded its 5000ms budget` and no `terminalReason=` field. In
current source `heartbeat-failed` requires `terminalReason: 'teardown-latched' | 'local-failure'`
(`ProviderProxyHeartbeatTerminalReason` in `provider-proxy-authority-fault.ts`), so a bare
`PROXY_CONTROL_RPC_TIMEOUT_MS` overrun no longer latches a fault. That is the correction
`wedged-coordinator-self-drain` records for 2026-08-26, and it is real.

**It is not enough for this requirement, by that entry's own admission**: it "does not save work through a
multi-minute coordinator stall".

The skew is wider than one field. `v0.10.9` is dated 2026-08-17, and every correction this entry cites
landed after it: the 2026-08-24 and 2026-08-26 corrections, and `df08df54` (#338), which `git merge-base
--is-ancestor` reports is not an ancestor of the tag. The tolerant path those corrections added — an
unanswered heartbeat becoming a retrying incident and a bounded hold instead of a latched fault — did not
exist in the build that produced these lines. So the fault-kind counts above say which faults that build
latched, and nothing about whether the hold now fires; a log in which only the decisive path ran is what a
build with no tolerant path looks like, not evidence of a defect in one. Only a measurement taken on
current source can speak to that.

## The number current source actually tolerates

`providerProxyAdoptionWindowMs` (`src/provider-proxy/orphan-deadline.ts`) is
`orphanTimeoutMs - teardownReserveMs`. At defaults that is `37,000 - 14,000` = **23,000 ms**.

So a 40-second stall of the kind measured above still reaps under current source. 23 s is closer to the
requirement than the shipped 5 s, and it is still under half of it.

`materialSchedulerLatenessMs` is one quarter of that same span, so the design already scales its
scheduler-lateness tolerance from this window rather than from a separate constant — whatever moves the
window moves that too.

## Which knobs exist

| constant | value | env override |
| --- | --- | --- |
| `PROXY_CONTROL_RPC_TIMEOUT_MS` | 5,000 ms | none |
| `PROXY_CONTROL_LEASE_MS` | 12,000 ms | none |
| orphan timeout | 37,000 ms default; stated range 19,001–300,000, of which the timing budgets accept only 36,001–300,000 | `CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS` |

Only the most generous of the three is configurable, and the two that are not set the floor for the one
that is, through `providerProxyDeadlineTimingIsValid`: the lease's own minimum derives from
`2 × rpc + heartbeat`, and the orphan timeout's from `lease + successorTail < adoptionWindow`, where
`PROXY_SUCCESSOR_TAIL_MS` is 10,000. So `MIN_EFFECTIVE_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS` is 36,001 — a
second check, rejecting part of the range the first one states — and **22,001 ms is the narrowest adoption
window that can be configured at all**, 999 ms below the default's 23,000. The knob moves this window up;
it cannot meaningfully move it down.

`CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS=74000` would put the adoption window at 60 s and is inside the
accepted range. That is a fact about the knob, not a proposal: it makes one host survive and leaves every
other host on 23 s.

## The open question — how, not whether

The requirement is not negotiable; the mechanism is genuinely open. Four shapes were visible from the
measurement, and none was chosen:

1. **Move the default.** Orphan timeout to 74,000 ms so the adoption window is 60 s out of the box.
   Cheapest, and it buys the number by making every teardown that legitimately needs the deadline wait
   longer — including the orphan sweep that exists because a coordinator really did die.
2. **Derive the window from observed lateness instead of a constant.** The coordinator already measures
   its own scheduler lateness and already computes `materialSchedulerLatenessMs` from the window; the
   arrow could point the other way, so a host under load earns tolerance and an idle host does not.
   Needs a rule for what a starved process may conclude from its own clock.
3. **Change what the off-process deadline accepts as evidence.** This was recorded as "take the deadline
   off the starved event loop", and that was already false when it was written. `createArmedEnforcer`
   (`src/provider-proxy/enforcement.ts`) is constructed in exactly two places — `createGuardian` and the
   reaper — which are separate processes that stay healthy through a coordinator stall, and its tick is
   clock arithmetic that never asks whether the coordinator still exists. There is nothing to relocate.
   What is open is the input: the tick counts wall-clock silence on a host where both parties share a
   kernel, so it cannot tell a coordinator that died from one that was descheduled. Replacing that input
   with an observation of the tenancy holder is the only one of the four that survives a stall longer than
   any constant, and it owes the third answer an exit — a holder that cannot be observed must become
   neither a demolition nor a hold with nothing to end it.
4. **Separate "did not answer" from "is gone" at this boundary.** A heartbeat RPC that missed its budget
   is the third answer, not evidence the provider died; the branch that produced this entry spent sixteen
   review rounds removing exactly that collapse elsewhere. Current source no longer latches on the RPC
   alone, but the adoption deadline still finalizes on silence.

The four are not exclusive. 1 is a stopgap that 2 or 3 would replace; 4 is a property any of them should
preserve.

**A pioneer reviewed this on 2026-09-02.** It rejected all four shapes as recorded and proposed anchoring
the demolition verdict on an identity-bound liveness observation of the tenancy holder rather than on
elapsed silence — the dual of the rule `.claude/rules/validation.md` already carries in the other
direction, that escalation requires observed life. **The proposal is not accepted.** `#338` decided the
opposite deliberately and said so: "Starvation past that still ends claim-bearing work; the authority over
silence is now one deadline owned by the party that also executes and reports the consequence." Making
silence insufficient takes that authority back out again, and that reversal has not been reviewed. The
design behind the proposal is not recorded here; this entry records the open question, not an answer.

## What is explicitly out of scope

Reducing the load. Multiple concurrent sessions and parallel builds are the intended way to use this
machine, and an entry that asks the user to run less has answered a different question. The suite-load
entry is about a gate starving the coordinator it is testing; this one is about the coordinator surviving
a host it does not control.

## Start condition

Pick between 1–4 first; each writes different code, and 1 is a constant while 3 changes what an already
external process is allowed to conclude. Whichever is chosen, the acceptance test is the same and should be
written first: a coordinator whose event loop is blocked for 60 seconds keeps its live claims, and one
whose provider is genuinely gone still reaps.

## Interacts with

- `wedged-coordinator-self-drain` — same mechanism, opposite blast radius. That entry records the wedge
  killing healthy work and carries the 2026-08-24 and 2026-08-26 corrections this one builds on. This line
  used to say option 3 above **is** that entry's external-supervision half, and that the two close together
  if 3 is chosen. They are separate. What remains there is a coordinator that never retires and what would
  restart it, which wants a supervisor that does not exist yet. The external supervisors for this blast
  radius already exist — the guardian and the reaper — and what they need is better evidence, not a new
  home. Neither entry closes the other.
- `containment-observation-deadline` — observation cost sitting outside the deadlines that bound
  containment. A wider adoption window changes that arithmetic's inputs.
- `provider-proxy-heartbeat-hold-status` — the hold this entry wants to last longer is the one that entry
  wants to survive coordinator death. Adjacent, not joint.
