# TODO — a superseded routing generation has no owner, and a clock cannot be one

**Status**: open, blocked on one capacity question stated at the end. Split from the render half on
2026-09-12 when a tier review found the two had no shared cause and no shared start condition.

## What exists

`handoff-routing.<generation>.db` takes its generation from a hash of the routing schema, so a schema
change mints a new address an older reader's selector never matches — the durable-shape rule in
[`design-philosophy`](../../.claude/rules/design-philosophy.md) §10, working as intended.

What nothing owns is the address left behind. Measured on the author's host on 2026-09-12: eleven
generations and 3.5 MB accumulated since 2026-08-23, none reclaimed.

## A time-based sweep was written, and reverted

It deleted superseded files whose mtime was older than `HANDOFF_ROUTING_COMPLETED_RETENTION_MS`. The
reasons it was wrong are the part that does not re-derive:

- **Deleting a record is a finalization, and mtime answers a different question.** It says only that
  nothing wrote recently, which is equally true of an address holding unresolved selections whose owner
  died months ago. §11 requires finalization to cite evidence for the obligation it discharges.
- **This build cannot read the address it would delete.** The contents are encoded in a schema
  `readHandoffRoutingStatus` classifies `foreign-generation`. Whether the address holds an obligation is
  structurally unanswerable here — the third answer, which does not authorize finalization.
- **A per-file clock does not survive SQLite.** Measured: one store's `.db` carried an August mtime
  while its `-shm` carried that same day's. Three files, three clocks, one store.
- **The constant was borrowed from a different obligation.** `HANDOFF_ROUTING_COMPLETED_RETENTION_MS`
  answers how long a completed pair is worth keeping *inside a live store*. Address retention has a
  different owner. [`export-lifetime.md`](./export-lifetime.md) exists because that substitution already
  shipped once, with a doc comment naming the wrong root.

## The shape that fits

`backend routing-status quarantine` already moves a store artifact aside and already offers `list` and
`clear --id`; its description reads "Inspect and clear retained routing-status journal evidence", which
is what a superseded generation is. Quarantining rather than deleting satisfies what §11 asks of a hold:
durable status an operator can read, keyed by an identity it can be acted on with, and an exit through a
command that exists. It also improves on the sibling precedent in `generation-mutation-coordination.ts`,
which reports a legacy path and offers nothing to do about it.

## Not `export-lifetime`'s shape

Worth stating because they look alike. That entry holds the user's content at 17 GB, where a retention
decision changes what a person gets back, so it owes a product decision. This is the coordinator's own
bookkeeping, capped per address, and an operator surface for retained evidence already ships. No product
decision is owed.

## Start condition

`MAX_HANDOFF_ROUTING_STATUS_QUARANTINES` is 16, and `list` exits 75 on overflow. Eleven superseded
generations would consume most of that ceiling and signal a fault for something that is not one. Decide
whether a superseded address competes for the same slots a damaged store uses, or gets its own
coordinate class. Nothing else blocks this.
