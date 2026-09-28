# TODO — decide supervision for already-running legacy coordinators

**Status**: current-build recovery is implemented; retained v0.10.0–v0.10.13 processes cannot acquire a new parent after launch.

`watchChild` in `src/coordinator-launch/supervisor.ts` uses a private heartbeat to detect a stopped coordinator event loop, extends its window across a shared scheduling freeze, and signals only its own unreaped child. `SENTINEL_TIMING` in `src/infra/sentinel-timing.ts` sets the ten-minute lapse, 30-second signal grace, and a separate deferral for Linux uninterruptible sleep. `createRequestLeaseOwner` in `src/coordinator/live/request-leases.ts` bounds ordinary unary in-flight ownership. A process held in kernel `D` state still cannot exit until the kernel operation returns, even after a signal.

An older coordinator that was launched without this supervisor may keep the socket while its event loop is stopped. The CLI can report `coordinator_recovering`, but it cannot confer parenthood retroactively. Decide whether retained builds need an external service manager or whether their remaining lifetime justifies accepting this bounded-period limitation. Any remedy must establish the exact process identity before signalling.
