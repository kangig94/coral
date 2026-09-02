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
| orphan timeout | 37,000 ms default, 19,001–300,000 valid | `CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS` |

Only the most generous of the three is configurable, and the two that are not set the floor for the one
that is: the lease's own minimum derives from `2 × rpc + heartbeat` through
`providerProxyDeadlineTimingIsValid`.

`CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS=74000` would put the adoption window at 60 s and is inside the
validated range. That is a fact about the knob, not a proposal: it makes one host survive and leaves every
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
3. **Take the deadline off the starved event loop.** The deadline that kills the work runs on the process
   the stall is happening to. This is `wedged-coordinator-self-drain`'s broader problem — external
   supervision — and it is the only one of the four that also survives a stall longer than any constant.
4. **Separate "did not answer" from "is gone" at this boundary.** A heartbeat RPC that missed its budget
   is the third answer, not evidence the provider died; the branch that produced this entry spent sixteen
   review rounds removing exactly that collapse elsewhere. Current source no longer latches on the RPC
   alone, but the adoption deadline still finalizes on silence.

The four are not exclusive. 1 is a stopgap that 2 or 3 would replace; 4 is a property any of them should
preserve.

## What is explicitly out of scope

Reducing the load. Multiple concurrent sessions and parallel builds are the intended way to use this
machine, and an entry that asks the user to run less has answered a different question. The suite-load
entry is about a gate starving the coordinator it is testing; this one is about the coordinator surviving
a host it does not control.

## Start condition

Pick between 1–4 first; each writes different code, and 1 is a constant while 3 is a process. Whichever
is chosen, the acceptance test is the same and should be written first: a coordinator whose event loop is
blocked for 60 seconds keeps its live claims, and one whose provider is genuinely gone still reaps.

## Interacts with

- `wedged-coordinator-self-drain` — same mechanism, opposite blast radius. That entry records the wedge
  killing healthy work and carries the 2026-08-24 and 2026-08-26 corrections this one builds on; option 3
  above **is** its external-supervision half. They close together only if 3 is chosen.
- `containment-observation-deadline` — observation cost sitting outside the deadlines that bound
  containment. A wider adoption window changes that arithmetic's inputs.
- `provider-proxy-heartbeat-hold-status` — the hold this entry wants to last longer is the one that entry
  wants to survive coordinator death. Adjacent, not joint.
