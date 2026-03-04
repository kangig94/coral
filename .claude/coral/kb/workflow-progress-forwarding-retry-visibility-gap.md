# Workflow Progress Forwarding Retry Visibility Gap
## Rule
When forwarding atom progress from session files, treat retry-attempt sessions as separate observability units. `launchAtomWithRetry` returns only the final successful session, so any progress emitted by earlier busy/retry sessions is not available to downstream polling in `waitForAllAtoms` unless explicitly bridged.
## Why
Assuming a single logical atom has one continuous session causes false expectations in UX and tests: users may see silence during contention and only later progress from the final launched session. This is not a parser bug; it is a lifecycle boundary between attempt sessions.
## Pattern
Right:
```text
Document and test that forwarding starts from the tracked successful session.
If attempt-level visibility is required, emit retry-attempt messages explicitly during launch.
```
Wrong:
```text
Assume reading final atom progress.jsonl includes progress from prior busy/retry sessions.
```
