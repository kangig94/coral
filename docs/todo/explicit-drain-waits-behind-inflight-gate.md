# An explicit drain can wait behind the pre-sequence in-flight gate forever

**Status**: open. Removing the unary gate is an owner decision.

## What is wrong

`IdleTimer.tryDrain` (`src/coordinator/live/idle.ts`) does not start an explicitly requested drain while
any request remains in flight. A long unary request can therefore keep `backend shutdown` before the
sequence for as long as that request lives, with no ledger and no deadline governing the wait.

`buildOpeningShutdownObligations` (`src/coordinator/shutdown.ts`) calls
`serverClose.start()` eagerly, before the `inflight drain` obligation is constructed, and the later
`server close` obligation only joins that already-running task. The `inflight drain` obligation bounds
only what is sequenced after it; the gate is the only thing keeping the transport answerable while unary
work is in flight.

Wait subscriptions are outside this gate by decision, so a drain interrupts them. IPC listener release
closes the socket; the client completes the iterator at that early EOF, and `coral-cli wait` exits 75 with
a cursor-based resume command. HTTP shutdown destroys active connections before tracked SSE responses are
ended, so `/jobs/wait` is also interrupted, but as a transport close rather than IPC's clean iterator EOF.

## Start condition

Give listener close its own ordering so it cannot begin before the in-flight wait it is supposed to
follow, or decide that an explicit drain stops answering immediately. Removing the gate before one of
those is settled trades an unbounded wait for a coordinator that cannot report the drain it just entered.
