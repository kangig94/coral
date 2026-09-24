# TODO — `backend status` collapses history past a threshold instead of not carrying it

**Status**: open. Split from the generation-lifetime half on 2026-09-12; the two share a branch and
nothing else.

## What shipped, and what it leaves

`backend status` rendered one block per routing invocation. Measured in the field: 417 lines where three
invocations needed an operator, against 15 from the previous build. The store was not accumulating — it
holds at its own ceilings, and the rendering site was deciding which invocations mattered.

It now asks the domain, through `handoffRoutingInvocationClassification` beside the classification table
that owns the `hold`/`history` distinction, and collapses history past a render threshold while never
withholding a hold.

**The threshold is the part worth removing.** It is a number the output shape changes at. The form with
no number is: history leaves `backend status` entirely for an inspection verb under `backend
routing-status`, whose description already reads "Inspect and repair". The domain's own rule — history
contributes zero to status — then has no exception.
[`design-philosophy`](../../.claude/rules/design-philosophy.md) §10 licenses the reshaping explicitly:
an old reader failing to find a field is permitted, and only redefining a value it already reads is not.

What it costs: the terminal blocks leave status, and `retirementHistoryTruncated` cannot be widened to
carry them — it is computed from a durable `retirement` row, and a durable field may not change meaning
under its own name. It needs a sibling aggregate rather than a wider one.

## One case neither form covers

A capacity-eviction tombstone is a hold, up to `MAX_RETIREMENT_TOMBSTONES` of them, each printing its own
`routing-status resolve --invocation <id>`. At that ceiling it is several hundred correct lines for as
many separate obligations. Capping it would hide an operator's work, which is the one thing a hold may
never do. The answer there is a bulk form of `resolve`, not a narrower render.

**Withdrawn by principle 12.** An operator bulk-resolving held tombstones is not a reachable exit on
the affected machine. That part of the design must be re-decided under "No Operator Is Watching" in
`.claude/rules/design-philosophy.md`.

## Start condition

Design the inspection verb before removing the threshold, so status never briefly loses evidence with
nowhere to read it. Re-decide the held-tombstone exit before implementing that independent member.
