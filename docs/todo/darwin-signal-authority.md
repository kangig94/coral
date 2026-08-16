# TODO — on macOS a process incarnation cannot authorize a signal

**Status**: open, and deliberately half-closed. Decided on `fix/workflow-replacement-cleanup-envelope` after the
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

`incarnationMayAuthorizeSignal(platform)` (`src/infra/node-process.ts:123`) is where this is stated. It returns
true only for linux. The token stays useful on Darwin for the _conservative_ direction, which is most of what
it is for: a false match reads as "still alive", which blocks a disappearance claim rather than licensing an
action.

## What is already closed

`verifySignalTarget` (`src/coordinator/handoff.ts`) refuses on Darwin before it reaches the anchor check. That
was the dangerous half: a durable handoff record can be arbitrarily old and can name a pid this build never
spawned, so the recorded identity is the _only_ thing standing between the coordinator and a stranger.

## What is open

`reapRecordedContainment` (`src/infra/process-containment.ts:366`) still signals on Darwin against the same
token. Four call sites:

| Call site                                                        | Reaps                                        | Holds the child? |
| ---------------------------------------------------------------- | -------------------------------------------- | ---------------- |
| `src/coordinator/live/provider-hosts/drain.ts:46`                | a provider host this coordinator spawned     | **yes**          |
| `src/coordinator/services/recovery/interrupted-performer.ts:105` | a previous coordinator process's work        | no               |
| `src/coordinator/services/provider-proxy-set/inheritance.ts:372` | another build's proxy set                    | no               |
| `src/provider-proxy/enforcement.ts:133`                          | the detached set group, from the reaper role | no               |

## Why the guard cannot simply be added — measured, not reasoned

Putting the refusal inside `reapRecordedContainment` fails
`tests/unit/coordinator/live/admission.test.ts > aligns coordinator-local host admission with darwin platform
capabilities`, through `provider-hosts/drain.ts:46` → `shutdownHandle` → `closeProviderServerEntry`.

That path is **coordinator-local provider-host teardown**, and unlike a proxy set it has no orphan deadline
behind it. A proxy set's guardian and reaper self-terminate when their deadline passes; a provider host does
not, and nothing else reclaims it. Refusing there trades an identity risk for a **certain** leak of a child
process with no reclaimer — strictly worse on the platform the guard is meant to protect.

## The shape of the fix — split by whether the caller holds the child

The table above is the fix. `drain.ts` is the only caller holding a live, unreaped child handle:
`ProviderServerEntry.child` (`src/providers/app-server-transport.ts:145`), reachable from the
`ContainedProviderServerHandle` that same path already carries (`:136-141`). POSIX does not reuse the pid of an
unreaped child, and the recorded process group id **is** the leader's pid — so _holding the handle is itself
the proof the identity was not recycled_. That path needs no token on any platform.

The other three reap processes they did not spawn — a previous coordinator's, another build's, a deliberately
detached group. They have no handle, the token is doing real work there, and that is exactly where the Darwin
refusal belongs and where it costs nothing to add.

So this is not a guard to insert. It is either a parameter that tells `reapRecordedContainment` which of its
callers already holds the proof, or a split into the two functions its callers already are.

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

None — the disposition is decided. What remains is the caller split above, plus one test per branch: a Darwin
harness where a handle-holding caller still reaps, and a non-handle caller refuses before signalling.

## How this interacts

[`kb-daemon-independent-containment.md`](./kb-daemon-independent-containment.md) and
[`wedged-coordinator-self-drain.md`](./wedged-coordinator-self-drain.md) sit in the same group but do **not**
close together. This entry is about the _authority_ to signal a correctly identified target; those two are
about there being no party left to signal at all. A fix for either of them still has to answer this one.
