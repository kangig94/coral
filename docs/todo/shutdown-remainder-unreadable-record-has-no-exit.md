# Shutdown-remainder unknown evidence has a durable exit

**Status**: resolved.

## Resolution

There is one shutdown remainder address, `shutdown-remainder.v1.json` in the run directory, so the question
this entry was opened for — what ends the visibility of a record this build cannot read — has a structural
answer rather than a retention policy. `classifyShutdownRemainderFile`
(`src/infra/shutdown-remainder-record.ts`) names the three unknowns (`unreadable`, `corrupt`, `unsupported`)
and nothing deletes on any of them; the bytes stay where they are, so a build that can decode them still
finds them. `readRecentShutdownRemainder` (`src/transport/http/backend/status.ts`) reports the
classification it observed, which is the visibility half of design-philosophy principle 11.

The exit is the next shutdown that leaves losses: `recordShutdownRemainder`
(`src/coordinator/shutdown-remainder.ts`) publishes by renaming its own stage over that address, which needs
write permission on the directory rather than read permission on the record, so a record this build cannot
read is still replaceable. Until then the report is one line naming one slot and its cause — not a hold, not
a growing set, and not something an operator is asked to clear (design-philosophy principle 12).

## Superseded observations

The earlier resolution described a bounded retention over a directory of per-instance records: a count cap,
a retention ranking, typed deferrals carrying `next-coordinator-start` as successor, and a `truncated`
cleanup authority that named lost subjects. All of that is gone with the directory. Its two premises were
refuted by measurement: a readable record's age is stated by its own `recordedAt` rather than inferred from
`stat`, so the `age-unobservable` deferral and the `inspect-age` refusal described a fact the content
already carried; and the directory could not grow to disk capacity, because a record this build cannot
delete sits in a directory this build cannot write, so writer and pruner fail together. The retention
ranking itself was measured to be a defect — an unstattable record ranked ahead of readable ones sat
permanently in the retention head and evicted the newest readable record, the one status exists to report.
