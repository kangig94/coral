# An explicit drain can wait behind the pre-sequence in-flight gate forever

**Status**: open. Removing the gate is an owner decision, and the first attempt at it was wrong.

## What is wrong

`IdleTimer.tryDrain` (`src/coordinator/live/idle.ts`) does not start an explicitly requested drain while
any request remains in flight. A long unary request can therefore keep `backend shutdown` before the
sequence for as long as that request lives, with no ledger and no deadline governing the wait.

Subscriptions are no longer part of this: they do not count toward the gate on either transport, so a
`coral-cli wait` holding its stream for up to 590 s neither delays a drain nor is cut by one.

## Correction, measured 2026-09-22

This entry previously said the shutdown sequence "later owns a bounded in-flight-drain obligation, so the
pre-sequence gate duplicates that wait without creating a ledger or a deadline", and that sentence
produced a wrong fix: the gate was deleted on the reasoning that the bounded owner would inherit the wait.

It does not inherit it. `buildOpeningShutdownObligations` (`src/coordinator/shutdown.ts`) calls
`serverClose.start()` eagerly, before the `inflight drain` obligation is constructed, and the later
`server close` obligation only joins that already-running task. The listening socket therefore begins
closing as the sequence starts, and the `inflight drain` obligation bounds only the obligations sequenced
after it. The gate is not a duplicate of that wait — it is the only thing keeping the transport
answerable while work is in flight.

Deleting the guard and running `tests/integration/transport/http/server.test.ts` failed 3/3, with
`GET /health` refused about 4 ms after `POST /admin/shutdown` while one request was held in flight; the
same file passed 3/3 with the guard in place.

## Start condition

Start by giving the listener close its own ordering, so it cannot begin before the in-flight wait it is
supposed to follow — or by deciding that an explicit drain stops answering immediately, which is a
behavior decision about observability, not a reporting change. Removing the gate before one of those is
settled trades an unbounded wait for a coordinator that cannot report the drain it just entered.
