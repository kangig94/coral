# TODO — make administrative drain waiting follow observed socket turnover

**Status**: partly implemented. The old budget mismatch is gone; the waiter still treats elapsed time as an address verdict.

`prepareTopLevelSpawn` in `src/transport/ipc/ensure.ts` waits at most 30 seconds for a draining coordinator's socket to release. `waitForSocketRelease` probes the address until that deadline and then throws `CoordinatorSocketReleaseTimeout`. The current handoff budget in `src/coordinator/shutdown.ts` is also 30 seconds, while ordinary shutdown uses a 10-second ledger budget. Upgrade succession transfers listening handles under its own protocol and does not use this waiter to evict a serving incumbent.

Neither a ledger deadline nor the waiter's deadline proves that the old address became bindable or that another coordinator took it. A failed shutdown continuation can leave the same process holding the socket after its ledger budget. The current sentinel can eventually end a stalled current-build child, but its recovery window is much longer than this wait, and a legacy coordinator has no sentinel.

## Remaining contract

Design the administrative wait around observed address turnover: bindable address, a different answering coordinator, or the same incumbent still possibly owning it. A reported drain bound can schedule another observation, not authorize replacement on its own. State what the CLI reports while the third answer persists and which supervisor, if any, can end it for a retained legacy build.

Keep the transport-local request cap in `drainBoundedClient` separate from the socket-release wait.
