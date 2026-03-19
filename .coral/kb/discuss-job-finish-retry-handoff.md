# Discuss Job Finish Must Preserve Retry Handoff
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
Do not clear discuss-side active job tracking from memory alone. Persist either the discuss-domain outcome or an explicit attempt-level `agent.job.finished` classification before clearing `currentJobId`, and keep enough retry metadata to resume malformed-response retries after restart.
## Why
Execution terminal state can land in the progress store before discuss has decided whether that attempt produced a valid bid, a retryable parse failure, or a terminal failure. If `currentJobId` disappears without a persisted finish record, recovery has no durable handoff: it may relaunch duplicate work, strand a retry loop, or collapse a retryable error into a terminal discuss failure.
## Pattern
Right:
```ts
appendDiscussEvents([
  { kind: 'agent.job.finished', outcome: 'retryable_parse_error', attempt: 2 },
]);
runtime.currentJobId = undefined;
runtime.lastAttemptOutcome = 'retryable_parse_error';
```

Wrong:
```ts
runtime.currentJobId = undefined;
// no persisted finish record; recovery must guess what happened
```
