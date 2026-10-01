# A contender that SIGTERMs a wedged incumbent has no budget left to bind

**Status**: open. Observed on the v0.10.13 → v0.10.14 upgrade (2026-10-01); on `main` the cause is in
`bindWithHandoff` (`src/coordinator/handoff.ts`), a path `feat/upgrade-escalation` deletes.

## What is wrong

`bindWithHandoff` measures one deadline, `totalBudgetMs` (`HANDOFF_DRAIN_TIMEOUT_MS`, 30 s), from its
first pass. Against an incumbent that accepts `replaced` but never finishes its drain, the whole budget is
spent waiting for a consented exit. Only then does the contender send SIGTERM and wait out the SIGTERM
grace. When the target is gone it logs `retrying bind`, but the next pass finds `remaining <= 0` with the
socket still bound and no verified holder, and throws `handoff_socket_holder_unverified` as a fatal
startup error. The successor dies a few hundred milliseconds after it won.

The upgrade only completed because the next CLI invocation spawned another 0.10.14 process, which bound
the now-free socket about 8 s later. Observed timeline (UTC):

| Time | Event |
| --- | --- |
| 00:04:36 | 0.10.14 requests `replaced`; the wedged 0.10.13 accepts but never finishes its drain |
| 00:05:08 | `Incumbent did not exit within 30000ms; kernel accepted SIGTERM` |
| 00:05:13 | `…its grace elapsed, and the target is gone; retrying bind` |
| 00:05:14 | `Fatal startup error: Handoff refused at the startup deadline …: the socket remained bound but no verified holder pid was available.` |
| 00:05:22 | A second 0.10.14 process reports `Running` |

So a successful escalation is converted into a fatal startup. Here a later trigger hid it, but with no
later trigger the namespace stays without a coordinator until something else invokes Coral.

## Start condition

The retry that follows a confirmed target exit must get its own bounded window to observe the socket's
release, or reclaim the path, instead of inheriting the exhausted drain budget. That window must still end
in a named disposition.

If `feat/upgrade-escalation` merges first, this escalation path is gone: a contender no longer signals an
incumbent, and the namespace supervisor's sentinel ends a wedged child. In that case:
- verify the analogous gap in the supervisor path — a successor launched after the supervisor retires a
  wedged child must not hit a startup deadline on a socket the dead child left bound;
- then delete this entry.

If a 0.10.x release from `main` ships before that merge, fix it on `main` directly.
