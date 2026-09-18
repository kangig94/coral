# The shutdown-abandonment producer was removed from the coordinator

**Status**: closed.

**What was wrong.** No current-build shutdown producer offered an abandonment action:
`foldRetainedAuthority` (`src/coordinator/shutdown-settlement.ts`) always yielded `operatorActions: []`, so
`abandonShutdownObligation` (`src/coordinator/lifecycle.ts`) could never find a
`shutdown-obligation-abandonment` offer, `state.operatorAbandonedShutdownObligations` could never gain a
member, and every `shutdownObligationAbandoned(<subject>)` early return in `src/coordinator/shutdown.ts`
(one per abandonable obligation plus the boundary's prepare/commit branches) was unreachable in
production.

**Resolution.** The internal `ShutdownOperatorAction` lifecycle type, retained-authority field, abandonment
state, and producer-side discharge branches were removed. `abandonShutdownObligation` now answers
`not-held` when no shutdown is live and `not-offered` while a shutdown is held. This matches principle 12:
the coordinator never waits for a person who is not on the machine.

**Compatibility surface.** `ShutdownOperatorAction` was never serialized and was not a cross-version wire
type. The actual IPC compatibility surface remains: the shutdown-recovery command, its request/result
schemas, and its route. The durable `shutdown-abandonment-status.v1.json` family also remains unchanged for
records written by older daemons.

**Interactions.** `docs/todo/shutdown-remainder-has-no-reader.md` (Track B decides what `backend
status` shows for a drain, which is where an offer would have to reappear if one is ever justified).
