# Workflow LaunchJob Busy Retry
## Rule
Do not treat capacity-limit handling as a synchronous dispatch concern when launching nested codex/claude jobs through `handleToolCall` + `launchJob`. Launch returns `{ status: "running" }` immediately, so `CliBusyError` can surface later as session `status: "error"` in `status.json`; retry logic must inspect launch responses and early session status, not only `try/catch` around dispatch.

## Why
If retry logic only wraps the dispatch call, busy-capacity failures escape the retry path because the failure happens after dispatch returns. Pipelines then appear to launch successfully but fail later with unhandled atom errors, violating deterministic orchestration and making concurrency behavior flaky under load.

## Pattern
Right:
```text
launch atom -> parse launch payload -> bootstrap status check ->
if busy: bounded backoff + retry
else: track session and continue
```
Wrong:
```text
try dispatch once
catch CliBusyError and retry
# assumes busy is thrown synchronously from dispatch
```
