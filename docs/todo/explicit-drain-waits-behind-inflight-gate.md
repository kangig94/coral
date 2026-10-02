# TODO — order listener close after the explicit drain's in-flight gate

**Status**: partly implemented. Unary request leases now bound ordinary in-flight ownership; the listener-close ordering is still open.

`IdleTimer.tryDrain` in `src/coordinator/live/idle.ts` starts an explicit administrative drain only when its in-flight count reaches zero. `createRequestLeaseOwner` in `src/coordinator/live/request-leases.ts` now aborts a request at its deadline and, after a settlement grace, records continuing work and releases its in-flight token. That removes the ordinary never-settling unary request from the gate. A failed abandoned-request status write still retains the token until recording succeeds, so the gate is not an unconditional wall-clock bound.

`buildOpeningShutdownObligations` in `src/coordinator/shutdown.ts` calls `serverClose.start()` before it constructs the bounded `inflight drain` obligation. The gate is currently what keeps the listener available while admitted unary work finishes. Starting listener close before that wait makes the two ordering promises disagree.

## Remaining decision

Give listener close its own ordering after the in-flight wait, or decide explicitly that administrative drain stops answering new requests immediately. Include the abandoned-request-recording failure in that decision: elapsed lease time alone does not establish that the request's continuation has a durable owner.

`watchChild` in `src/coordinator-launch/child-watch.ts` provides independent current-build supervision if the coordinator stops making progress. It does not choose when a responsive coordinator should close its listener.
