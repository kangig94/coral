# Project-Scoped Compaction Handoff Must Not Be Singleton
## Rule
When compaction recovery is project-scoped and cannot rely on `session_id` continuity, do not store recovery state in a single shared snapshot file with overwrite/delete-on-read semantics. Use a short-lived set of uniquely named snapshot files, merge them by stable key (`jobId` here), and clean them up by TTL.
## Why
With a singleton handoff, overlapping compactions in the same project race each other: a later PreCompact can overwrite the earlier snapshot, and either PostCompact can delete the only recovery state before the other compacted session resumes. That silently drops live-job recovery exactly in the scenario the handoff exists to protect.
## Pattern
Right:
```text
PreCompact -> write active-jobs-<unique>.json
PostCompact -> read all fresh project snapshots
PostCompact -> union by jobId
PostCompact -> delete only stale/malformed snapshots
```

Wrong:
```text
PreCompact -> overwrite active-jobs-compact.json
PostCompact -> read active-jobs-compact.json
PostCompact -> delete it immediately
```
