# TODO — routing status prints history, and a superseded generation has no owner

**Status**: open, and both halves are what a direction review left behind after the contained fixes
landed. Neither is a defect anyone is waiting on; both are the stronger form of a change already made.

## What was fixed, and what that leaves

`backend status` rendered every routing invocation. Measured in the field: **417 lines for three that
needed an operator**, the rest being 256 terminals and 128 compaction retirements. The rendering site
decided which mattered, re-deriving by hand a table the domain already owns.

It now asks `PERSISTED_DISPOSITION_CLASSIFICATIONS` through
`handoffRoutingInvocationClassification`, and collapses history past a render threshold while never
withholding a hold.

**The threshold is the part worth removing.** It is a number the output shape changes at, and the
existing tests pass only because their fixtures are small. The form with no number is: history leaves
`backend status` entirely and lives behind an inspection verb under `backend routing-status`, whose
description already reads "Inspect and repair". The domain rule — *history contributes zero to status*
— then has no exception. Design policy explicitly licenses this: reshaping output so an old reader
fails to find its field is permitted; only redefining a value it already reads is not.

What that costs: the terminal blocks leave status, and `retirementHistoryTruncated` cannot be widened
to carry them, because it is computed from a durable `retirement` row and a durable field may not
change meaning under its own name. It needs a sibling aggregate, not a wider one.

**One case the threshold does not cover and the verb would not either.** Capacity-eviction tombstones
are holds, up to `MAX_RETIREMENT_TOMBSTONES` of them, each printing a distinct
`routing-status resolve --invocation <id>`. At the ceiling that is 512 correct lines for 128 separate
obligations. Capping it would hide work, which is the one thing a hold may never do. The honest answer
is a bulk form of `resolve`, not a narrower render.

## Superseded generations have no owner, and a clock is not one

`handoff-routing.<generation>.db` takes its generation from a hash of the routing schema, so a schema
change mints a new address an older reader's selector never matches — the durable-shape rule, working.
What nothing owns is the address left behind: **11 generations and 3.5 MB on the author's host since
2026-08-23**, none reclaimed.

A sweep deleting them on a 30-day mtime was written and then reverted, for a reason worth keeping:

- **Deleting a record is a finalization, and mtime is evidence about a different question.** It says
  only that nothing wrote recently, which is equally true of an address holding unresolved selections
  whose owner died months ago.
- **This build cannot answer what the address holds.** Its contents are encoded in a schema this build
  refuses to parse — `readHandoffRoutingStatus` classifies it `foreign-generation`. "Does it hold an
  obligation" is structurally unanswerable here, which is the third answer, and unknown does not
  authorize finalization.
- **A per-file clock does not survive SQLite.** Measured: one store's `.db` carried an August mtime
  while its `-shm` carried today's. Three files, three clocks, one store.
- **The reuse was the wrong constant.** `HANDOFF_ROUTING_COMPLETED_RETENTION_MS` answers how long a
  completed pair is worth keeping inside a live store. Address retention is a different obligation with
  a different owner. `export-lifetime.md` exists because this exact substitution already shipped once.

**The shape that fits.** `backend routing-status quarantine` already moves a store artifact aside and
already offers `list` and `clear --id` — retained routing-status journal evidence is what it is for. A
superseded generation quarantined rather than deleted satisfies all three of what a hold owes: durable
status an operator can read, keyed by an identity it can be acted on with, and an exit through a
command that exists. It also improves on the sibling precedent in
`generation-mutation-coordination.ts`, which reports a legacy path and offers nothing to do about it.

**The blocking question, and it is real.** `MAX_HANDOFF_ROUTING_STATUS_QUARANTINES` is 16, and `list`
exits 75 on overflow. Eleven superseded generations would consume most of that and start signalling a
fault for something that is not one. Does a superseded address compete for the same slots a damaged
store uses, or does it get its own coordinate class? That is the decision this entry is waiting on.

## Not the same as `export-lifetime`

Worth stating because the two look alike and the answer differs. The export tree is the user's content,
17 GB, where a retention decision changes what a person gets back — a product decision, which is why
that entry is held. This is the coordinator's own bookkeeping, 3.5 MB, capped at 1 MiB per address, and
an operator surface for retained evidence already ships. No product decision is owed here; only the
capacity question above.

## Start condition

Either half can be taken alone. The first wants the inspection verb designed before the threshold is
removed, so status never briefly loses evidence with nowhere to read it. The second wants the
quarantine capacity question answered first.
