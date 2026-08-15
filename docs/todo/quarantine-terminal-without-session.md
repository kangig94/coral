# TODO — recovery quarantines a growing pile of terminals that carry no `refs.sessionId`

**Status**: open, **and actively accumulating**. Recorded 2026-08-15 while the count was still climbing
on a live daemon. This is the only entry in this directory whose subject is growing while it is being
written.

## What is observed

`backend status` reports recovery as degraded:

```
recovery: degraded
  reason: recovery-quarantine (27 unresolved rows)
  last error: Job terminal event 62029 has no refs.sessionId.
```

The count went 21 → 25 → 26 → 27 over roughly four hours of ordinary use, and the event sequence in the
message advanced each time. It is not a fixed backlog from one incident; something produces a new one
regularly.

## What it is not

**It is not the `0.10.6` daemon lacking #311.** That was the first hypothesis, because the machine had
been running an old coordinator against a new install for hours (see `build-identity-and-upgrade.md`).
It survived a restart onto `0.10.8`: the fresh daemon reported the same degraded reason and the count
kept rising. #311 narrowed the retention-pair source's SQL to terminals that **have** a `sessionId`;
whatever is producing these reaches the same complaint by another route.

Recorded explicitly because the wrong attribution is cheap to repeat: an old-daemon explanation fits the
symptom, was believed, and is false.

## The shape worth checking first

A workflow root job has no provider session — `sessionId` is `null` on its launch record by
construction. A terminal for such a job legitimately carries no `refs.sessionId`. Any consumer that
treats "job terminal" as implying "has a session" will therefore fail on every workflow terminal, and
will keep failing as long as workflows keep running. That matches the accumulation rate.

So the first question is not "which record is malformed" but **which reader is asserting a session that
the emitting job never had**. The answer decides whether the fix is at the reader, at the enumeration
that selects records for it, or at the event's own refs.

## What to gather before deciding

- `coral-cli backend recovery-quarantine list` — the boundary, subject kind, and revision of the rows.
  If they are all one boundary, the enumeration is the suspect; if they span boundaries, the emitting
  side is.
- For one named event sequence, the event's `stream_kind`, `refs`, and the `jobKind` of the job it names.
  A `jobKind: 'workflow'` row confirms the shape above and ends the investigation early.
- Whether the rows are retryable or terminal in the quarantine's own vocabulary. Deferred work that a
  later build resolves is a different severity from work nothing will ever resolve.

## Why it matters beyond the count

Quarantine is the disposition #316 introduced so that a record this build cannot read stops destroying
the job it describes. That is the right trade, and it is working. But it converts an unreadable record
into **deferred** work, and nothing tells the operator that a job stopped moving for that reason. A
pile that only grows is the failure mode that trade accepts, and it needs an owner.

## Explicitly out of scope

The quarantine mechanism itself, the recovery enumeration boundary, and #316's disposition. This item is
only about what keeps producing rows and whether the reader or the record is wrong.

## Start condition

None — the data is on any machine that has run workflows, and the first two commands above are reads.
