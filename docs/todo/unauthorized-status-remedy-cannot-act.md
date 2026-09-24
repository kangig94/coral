# TODO — the remedy for a token mismatch sends the reader to a command the coordinator will reject

**Status**: open. Found 2026-09-24 by a review of `backend start`; the defect predates it.

## The fact

`backend status` reports `unauthorized` when the coordinator answering at the recorded address rejects the
discovery record's boot token. Its remedy (`formatDaemonStatus`, `src/cli/format/backend.ts`) prints
`command=coral-cli backend shutdown` and then says to retry a mutating command. Neither can act:

- `backend shutdown` presents that same record's token, so the coordinator answers `401`, which the shutdown
  path classifies as `capability_rejected` (`src/transport/http/backend/shutdown.ts`).
- A mutating command or `backend start` reaches the same coordinator through `ensure`, cannot authenticate it,
  and cannot replace a coordinator that is not draining, so it refuses rather than starts.

The reader — under design-philosophy §12, an LLM that will run the printed line — is handed a command that
fails, then a retry that fails the same way, with nothing that says what would end the state.

## What `backend start` did about it

Nothing beyond not making it worse: the `unauthorized` branch was deliberately left without a
`command=coral-cli backend start` line, because start cannot act there either.

## What would close it

A remedy that acts on the coordinator that actually answered rather than on the record: identify its
process from the evidence status already holds, stop it, and let the next start publish a record whose token
matches. Until a command can do that, the honest output names what is waiting and on what, and prints no
command that is known to be rejected.

## Start condition

Decide which process identity status can prove for the answering coordinator without its token, and whether
stopping it is an operation Coral may perform unattended.
