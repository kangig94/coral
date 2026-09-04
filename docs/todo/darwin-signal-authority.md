# TODO — on macOS a process incarnation cannot authorize a signal

**Status**: closed for live durable launches; recovered processes and provider-host admission remain fail-closed.

## The token, and the one thing it cannot do on Darwin

`ProcessIncarnation` (`src/infra/node-process.ts`) answers "is the process at this pid the same one that was
recorded". Linux answers it exactly: `linux:<boot_id>:<startTicks>` is **boot-relative**, so no wall-clock
change can move it, and two processes share one only by starting in the same tick — the pid space would have
to wrap inside ~10ms.

Darwin cannot. macOS exposes no boot-relative start time without a native addon, so the probe reads
`ps -o lstart=` at **one-second resolution** and frames it with `kern.bootsessionuuid`. The session UUID closes
the across-reboot half completely. What stays open is _within_ one boot, and it is worse than "one second":

**`ps -o lstart=` prints local time, and `Date.parse` reads a zone-less string as local.** During the autumn
DST fallback the same displayed string names two instants an hour apart, so the collision window is not one
second but **one hour, once a year, on a schedule anyone can look up**. Inside it, a reused pid on the same
displayed second produces a byte-identical token for a different process — and equality on this path
authorizes `SIGKILL`.

`incarnationMayAuthorizeSignal(platform)` (`src/infra/node-process.ts`) is where this is stated. It returns
true only for linux. The token stays useful on Darwin for the _conservative_ direction, which is most of what
it is for: a false match reads as "still alive", which blocks a disappearance claim rather than licensing an
action.

## What is already closed

`gracefulKillByPid` (`src/infra/process-supervision.ts`) refuses before sending SIGTERM when the caller has
no recorded incarnation, when the platform cannot use an incarnation to authorize a signal, when a fresh
probe is unavailable, or when the fresh incarnation differs. A recovered pid-only termination request on
Darwin therefore sends no signal. A live durable launch is different: `DurableLaunchResult`
(`src/runtime/ports.ts`) retains an exact wrapper-scoped signal authority, and durable cleanup supplies it to
`reapRecordedContainment` for as long as the wrapper has not exited.

`verifySignalTarget` (`src/coordinator/handoff.ts`) refuses on Darwin before it reaches the anchor check. That
was the dangerous half: a durable handoff record can be arbitrarily old and can name a pid this build never
spawned, so the recorded identity is the _only_ thing standing between the coordinator and a stranger.

Two more paths were closed after review found them, and they are closed rather than deferred because a proxy
role that is never given control ends itself: `buildGuardianSpawnUndo`
(`src/coordinator/live/provider-proxy/spawn-undo.ts`) and `isStillTheRecordedProcess`
(`src/provider-proxy/role-main.ts`), the guardian-construction unwind. Refusing there costs the orphan
deadline — 37 seconds by default — and nothing permanent.

`tests/invariants/signal-authority.test.ts` now enumerates every file that signals a bare pid, so this
document is no longer the only place the open ones are written down. It found four more, unrelated to
containment; they are [`durable-cli-signal-authority.md`](./durable-cli-signal-authority.md).

## Resolution

`reapRecordedContainment` now applies one rule to the group leader and every recorded root: a signal requires
either a retained child handle whose exit has not been observed, or a fresh matching incarnation from a
platform for which `incarnationMayAuthorizeSignal` returns true. The handle state is checked again at the
signal boundary. A fresh Darwin token alone never passes that gate.

Live durable cleanup and handle-backed provider-host teardown supply the optional live-child proof. Durable
cleanup uses the proof only for the wrapper-led group; an additional recorded child root is observed after
the group is reaped and remains held if its absence cannot be established. A recovered durable process has no
such proof and retains its non-success disposition.

Provider-host admission is Linux-only. Provider initialization can fail after containment is recorded but
before the handle is returned, so a later cleanup may have no live-child proof. Admitting that launch on
Darwin would recreate an obligation no teardown path can discharge. Handle-backed teardown still threads the
exact child authority to the shared reaper, but admission is gated by the weakest teardown path rather than
the common one.

A completed durable result whose containment cannot be observed publishes a job progress status naming the
pid and reason. Cleanup retries while ownership remains held. After that status is visible, `coral-cli abort
<job-id>` explicitly abandons the hold: the job records that local ownership was released without proving
process absence or terminating the process. Ordinary abort before a completion hold remains a termination
request, not an abandonment.

The same gate applies after SIGTERM. If a target exits and its number is reused during the grace period, the
fresh observation either proves absence/mismatch or refuses escalation; it cannot authorize SIGKILL from
numeric liveness alone.

## Related reporting rule

Leader absence or an incarnation mismatch cannot prove group absence. The asynchronous containment observer
therefore probes the group: observed group absence may complete the obligation, while a surviving group
returns `recorded-group-unattributable` and an unanswered group probe remains unobservable.

## Liveness is not identity, and escalation still trusts it

The three-valued probe fixed _which_ answer authorizes a signal. It did not fix what that answer proves.
`'alive'` says the number is occupied. It does not say the occupant is the process that was recorded — and the
window is the escalation grace itself: the recorded target receives SIGTERM, exits, its pid or process-group
id is reused, and the confirming probe reports `'alive'`. SIGKILL then goes to whoever holds it now.

`reapRecordedContainment` does not have this problem: it revalidates the recorded incarnation before it
signals. The paths that do are the ones whose name says so — `reapUnheldTarget` in `role-main.ts` and
`buildGuardianSpawnUndo` — which signal a bare number precisely because there is no containment record to
revalidate against.

So the question is not "add a re-check". It is **whether a path that signals an unheld number should exist**,
which is the same question the caller split above is already blocked on, arrived at from the other side. Both
want the same answer: a signal is authorized by held-child proof or by a platform-authoritative identity match,
and nothing else. Close them together.

Not folded into the change that found it, deliberately. Adding a revalidation to those two call sites without
answering what a caller with no reclaimer does when it refuses is how the containment close was reverted twice
already in this branch's history.

## The cheap partial, recorded because it is easy to miss

Running the probe as `TZ=UTC ps -o lstart=` removes the DST ambiguity: two processes an hour apart then print
different strings, so the annual window closes for the cost of one env var on the `execFileSync` in
`probeMacProcessIncarnation`. **It does not close the entry** — a backward NTP step within one boot still lets
a reused pid land on the same displayed second, and the resolution is still one second. It narrows a
predictable hour into an unpredictable rarity, which is worth having and is not a substitute for the split.

Unverified on macOS: this branch's work was done on Linux, and `ps`'s honouring of `TZ` was reasoned from libc
behaviour, not observed. Confirm before relying on it.

## Explicitly out of scope

**A native addon** for a boot-relative macOS start time. It would close this exactly, and it would put a
compiled artifact into a plugin that installs from a git subdir — see `project_windows_not_supported`'s
reasoning about what can actually reach a user. Not a trade worth making for this.

**Widening the token to carry sub-second precision.** `ps` has no such field; the precision does not exist to
read.

## Verification shape

The containment tests cover both authorization limbs: Darwin reaping proceeds while retained handles report
their targets unexited, and refuses without signalling after exit is observed or when no handle exists.

## How this interacts

[`kb-daemon-independent-containment.md`](./kb-daemon-independent-containment.md) and
[`wedged-coordinator-self-drain.md`](./wedged-coordinator-self-drain.md) sit in the same group but do **not**
close together. This entry is about the _authority_ to signal a correctly identified target; those two are
about there being no party left to signal at all. A fix for either of them still has to answer this one.
