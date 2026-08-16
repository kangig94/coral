# TODO — operator quarantine for unreadable provider-operation evidence

**Status**: open. Startup now refuses recovery when an active provider-operation row cannot be attributed,
but there is deliberately no automatic or operator exit for evidence whose process targets are not provably
absent.

## What exists

`src/coordinator/lifecycle.ts` keeps the launch fence active and the coordinator at `kernel-ready` when
provider-operation admission returns an exact `{ key, revision }` blocker. Automatic retirement in
`src/coordinator/services/recovery/index.ts` removes a superseded row only after every readable process target
is observed absent.

The existing `backend recovery-quarantine clear` command cannot help. Its quarantine table stores recovery
coordinates and diagnostic text, not the provider-operation row's raw value or its matching due-entry bytes.
Provider-host eviction also requires an identifiable host, which is exactly the evidence an unattributable row
may not contain.

Until this TODO ships, **`refused` has no operator exit for a row whose targets are not provably absent**. The
operator can restore the older build that understands the row, or inspect and evict a host when one can be
identified; there is no current command that safely abandons the raw row.

## Required shape

- Add a journal/store-owned quarantine namespace or table that preserves the original active key/value and
  every matching due-entry key/value byte-for-byte.
- Add an authenticated CLI/RPC operation addressed by exact key and content revision.
- In one SQLite transaction, compare-and-swap the active bytes, write all raw evidence into quarantine, and
  remove the active rows. A stale coordinate must not move replacement bytes.
- Preserve the crash invariant: either every byte remains active, or every byte is recoverable from quarantine;
  never neither.
- Emit an audit record that identifies the operator decision and the exact revision abandoned.

This is not routine cleanup. Removing an unattributable active row can let generic recovery terminalize an
unknown job while an unknown provider process survives. The command therefore represents explicit,
operator-authorized abandonment and must say that plainly before acting.

## Explicitly out of scope

Automatic quarantine of unobservable rows, interpreting foreign record generations, or treating a missing
identity as evidence of process absence. Those would erase the uncertainty the refusal is designed to retain.

## Start condition

Define the durable raw-evidence schema and operator confirmation/audit contract together. The store transaction,
RPC, and CLI must ship as one capability because exposing removal without durable preservation would create an
irrecoverable half-state.
