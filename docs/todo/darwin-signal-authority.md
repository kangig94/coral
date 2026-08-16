# TODO — on macOS a process incarnation cannot authorize a signal

**Status**: open, and deliberately half-closed. Decided on `refactor/process-incarnation-token` after the
handoff half shipped and the containment half was attempted, measured against the suite, and reverted.

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

## What is open

`reapRecordedContainment` (`src/infra/process-containment.ts:366`) still signals on Darwin against the same
token, from four call sites:

| Call site                                                        | Reaps                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------- |
| `src/coordinator/live/provider-hosts/drain.ts:46`                | a provider host this coordinator spawned                |
| `src/coordinator/services/recovery/interrupted-performer.ts:105` | a previous coordinator process's work                   |
| `src/coordinator/services/provider-proxy-set/inheritance.ts`     | another build's proxy set                               |
| `src/provider-proxy/enforcement.ts:133`                          | the detached set group, from the guardian or the reaper |

## Why the guard cannot simply be added — measured, not reasoned

Putting the refusal inside `reapRecordedContainment` fails
`tests/unit/coordinator/live/admission.test.ts > aligns coordinator-local host admission with darwin platform
capabilities`, through `provider-hosts/drain.ts:46` → `shutdownHandle` → `closeProviderServerEntry`.

That path is **coordinator-local provider-host teardown**, and unlike a proxy set it has no orphan deadline
behind it. A proxy set's guardian and reaper self-terminate when their deadline passes; a provider host does
not, and nothing else reclaims it. Refusing there trades an identity risk for a **certain** leak of a child
process with no reclaimer — strictly worse on the platform the guard is meant to protect.

## The shape of the fix — split by live-child proof, not by call site

An earlier revision of this document said `drain.ts` is the one caller that holds a live, unreaped child, so
holding the handle is itself proof the pid was not recycled, and the split is therefore per call site. **Two
reviewers falsified that independently and the correction is the useful part**, so it is kept in place:

- `drain.ts:174` reaps with `handle === null`. When a spawn fails after containment was recorded,
  `provider-hosts/recovery.ts:71` closes an entry that has no handle at all, and the same call site then reaps
  from the recorded identity alone.
- Even when a handle exists it may name an already-exited child. `shutdownHandle` reaps _after_ graceful
  shutdown, and `app-server-transport.ts:359` resolves that path from the child's own close event. Node reaps
  on exit; a reaped pid is free. Retaining the JavaScript object proves nothing about the pid.
- And the signal targets the **group**, not the leader, which is a _narrower_ hazard than an earlier revision
  claimed. POSIX reserves a process-group id for the lifetime of the group, and that lifetime ends only when
  its last member leaves — so while descendants survive, no unrelated group can hold that pgid. What remains
  is the ordinary case: once the group is genuinely empty the id is free, and "the leader was alive when I
  looked" does not establish that the group is still ours at the moment the signal lands.

The real predicate is therefore _"has this child exited yet"_, evaluated at the moment of the signal — and
`ChildProcessLike` (`src/infra/port-types.ts:117`) cannot answer it: it exposes `pid`, `kill`, and a `'close'`
event, with no synchronous exit state. Adding one touches every fake in the suite, which is why this is a
change rather than a guard.

So the rule to implement is one sentence with two limbs: **signal a recorded pid only when the child is known
not to have exited, or when the platform's incarnation may authorize a signal and it matches.** The first limb
is what lets macOS keep tearing down its own live children; the second is what stops it from guessing about
anything else.

## A second thing this path reports that it cannot prove

`observeContainment` returns `absent` when the recorded leader's incarnation no longer matches — and its own
comment says what that costs: "This can strand original members: the guarantee is never to signal the wrong
group, not always to reap ours." The signal side of that is right. The _reporting_ side is not: a POSIX group
outlives its leader, so `isAlive(-processGroupId)` can be true at the moment this answers `absent`, and every
caller reads that answer as teardown having succeeded.

A delegated repair pass changed it to throw `process_identity_unverified` when the group is still alive. That
was reverted rather than kept, and the reason is the same one that reverted the Darwin containment close:
`closeProviderServerEntry` has no reclaimer, and `provider-hosts/index.ts`'s close-all rethrows the first
rejection — so a case that used to end shutdown cleanly would end it with an error instead. Trading a silent
strand for a failed shutdown is not obviously the better half.

The property is right and the delivery is what is open. Whatever closes this has to answer what a caller with
no reclaimer does with the truth, which is the same question the caller split above is already blocked on.
Close them together.

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

## Start condition

None — the disposition is decided. What remains is a synchronous exit state on `ChildProcessLike` and the
two-limbed rule above, plus one test per limb: a Darwin harness where a caller with a not-yet-exited child
still reaps, and one whose child has closed refuses before signalling.

## How this interacts

[`kb-daemon-independent-containment.md`](./kb-daemon-independent-containment.md) and
[`wedged-coordinator-self-drain.md`](./wedged-coordinator-self-drain.md) sit in the same group but do **not**
close together. This entry is about the _authority_ to signal a correctly identified target; those two are
about there being no party left to signal at all. A fix for either of them still has to answer this one.
