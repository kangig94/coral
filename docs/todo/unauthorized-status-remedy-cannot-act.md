# TODO — the remedy for a token mismatch sends the reader to a command the coordinator will reject

**Status**: honest-output half shipped. Identifying and stopping the answering coordinator remains open.
Found 2026-09-24 by a review of `backend start`; the defect predates it.

## The original defect

`backend status` reports `unauthorized` when the coordinator answering at the recorded address rejects the
discovery record's boot token. Its former remedy (`formatDaemonStatus`, `src/cli/format/backend.ts`) printed
`command=coral-cli backend shutdown` and then said to retry a mutating command. Neither can act:

- `backend shutdown` presents that same record's token, so the coordinator answers `401`, which the shutdown
  path classifies as `capability_rejected` (`src/transport/http/backend/shutdown.ts`).
- A mutating command or `backend start` reaches the same coordinator through `ensure`, cannot authenticate it,
  and cannot replace a coordinator that is not draining, so it refuses rather than starts.

The reader — under design-philosophy §12, an LLM that will run the printed line — was handed a command that
fails, then a retry that fails the same way, with nothing that said what would end the state.

## Shipped: honest output

The `unauthorized` branch now prints no remedy command or mutating-command retry advice. It says that the
coordinator answering at the recorded address does not accept this record's token, that Coral cannot stop or
replace it with that token, and that startup remains blocked until that coordinator exits, when its idle timeout (six hours by default) passes with no authenticated request, since rejected requests do not count as activity, or when the machine restarts.

`backend start` reports that it could not verify the running coordinator, without printing the status remedy.
There is no daemon-status JSON mode: `backend status --json` requires `--request <record-id>` and reports an
abandoned request instead.

## Open: identify and stop the answering coordinator

A remedy that acts on the coordinator that actually answered rather than on the record: identify its
process from the evidence status already holds, stop it, and let the next start publish a record whose token
matches. This requires a separate design decision; honest output does not identify or stop that process.

## Start condition

Decide which process identity status can prove for the answering coordinator without its token, and whether
stopping it is an operation Coral may perform unattended.
