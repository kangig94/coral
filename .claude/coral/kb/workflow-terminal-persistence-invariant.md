# Workflow Terminal Persistence Invariant
## Rule
Workflow terminal handling must make two invariants explicit: (1) a path-only workflow `wait()` result is only valid after `result.md` has been written successfully, so the workflow terminal event must be appended after file persistence; and (2) workflow-owned sessions must transition to `non_resumable` on every terminal exit, not just success, because `executeWorkflow()` creates synthetic sessions without a resumable provider conversation contract.
## Why
If `appendTerminal()` happens before `result.md` exists, `waitStream()` can surface a workflow path that races the filesystem or never becomes readable when the write fails. If only the success path calls `setNonResumable()`, failed and aborted workflow sessions stay accidentally resumable even though there is no valid conversation to resume, leaking inconsistent session state into later operations.
## Pattern
```typescript
// Wrong: terminal first, file second, and only success locks the session down
appendTerminal(jobId, sessionId, terminalResult, phase);
writeResultMd(jobId, markdown);
if (phase === 'completed') {
  sessionManager.setNonResumable(sessionId);
}
```

```typescript
// Right: persist the workflow artifact first, then expose the terminal result
writeWorkflowResultMdOrThrow(jobId, markdown);
appendTerminal(jobId, sessionId, terminalResult, phase);
sessionManager.setNonResumable(sessionId);
```
