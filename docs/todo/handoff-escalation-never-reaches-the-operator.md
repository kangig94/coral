# TODO — the one startup failure that names its own remedy is the one nobody sees

**Status**: open, and separable. Found by a PR-gate reviewer tracing a CLI message rather than reading it.
The message was corrected to stop promising this text; making the text actually arrive is the other half and
is a behaviour change with its own argument, which is why it is here.

## What exists

`bindWithHandoff` refuses a socket handoff it cannot complete by throwing `HandoffEscalationError` (see
`HandoffEscalationError` in `src/coordinator/handoff.ts`), whose message tells an operator that manual repair
is required and what to repair. It is the most specific thing Coral says about a coordinator that could not
start, and no operator has ever read it.

The path it dies on:

1. `HandoffEscalationError extends Error`. It is not a `CoralSetupError`.
2. `writeStartupErrorSentinel` (see `writeStartupErrorSentinel` in `src/coordinator/bootstrap-diagnostics.ts`)
   calls `serializeCoralSetupError` and returns immediately when it answers `null`.
3. `serializeCoralSetupError` (see `serializeCoralSetupError` in `src/runtime/errors.ts`) answers `null` for
   anything that is not a `CoralSetupError`.
4. So no sentinel is written. The CLI polls for one while it waits for the coordinator to bind (see
   `matchingStartupError` in `src/transport/ipc/ensure.ts`), finds nothing, and throws a generic
   `BackendUnreachableError` when its deadline expires.

A later `backend status` does read the separate startup diagnostic, but that record is not a documented setup
error either, so it renders the generic "inspect the coordinator log" fallback. The escalation's own sentence
never appears on any surface.

## Why this is worth fixing rather than accepting

Every other refusal on this branch was made to name an exit an operator can take. This one already has the
best sentence in the system — it was written to say exactly what is wrong and what to do — and the delivery
is what is missing. The cheap half is done: two `no_record_socket_present` messages used to tell the operator
to expect this text, and now do not, because promising a string the flow cannot deliver is the defect this
branch exists to remove. But the result is that a real escalation still surfaces as a timeout.

## What has to be decided

`CoralSetupError` is a documented registry: each code carries a `userMessage`, a `remediation`, and an exit
code, and adding a member is a contract change, not a refactor. Two shapes are available and they are not
equivalent.

- **Give the escalation a documented code.** It then travels the sentinel path unchanged, the CLI prints its
  remediation, and the exit code is decided once rather than defaulting. This is the shape the registry
  exists for, and the cost is that a coordinator-internal failure becomes part of the CLI's public error
  vocabulary — which is a decision about what the CLI promises, not an implementation detail.
- **Widen what the sentinel accepts.** `writeStartupErrorSentinel` could serialise any error's message rather
  than only documented ones. That reaches the operator with less ceremony and no new contract member, but it
  also means the sentinel carries text nobody wrote for an operator, from any failure that reaches bootstrap
  — which is how a startup surface fills with internal strings.

The first is the smaller change to what a reader sees and the larger change to the contract; the second is
the reverse. Whichever is chosen, the check that closes this entry is the same: drive a handoff escalation
and confirm the escalation's own words reach a terminal, rather than confirming a sentinel file exists.

## Explicitly out of scope

The handoff decision itself — when a bind may escalate rather than wait — is not in question here. This entry
is only about the escalation, once taken, being legible to the person who has to act on it.
