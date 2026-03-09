# Execution Terminal Write Recovery Needs A Non-Recursive Fallback
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
If `appendTerminal()` can throw, the recovery path must not call helpers that already depend on `appendTerminal()`. Terminal write recovery needs a separate status-only fallback path; otherwise the fallback re-enters the same broken JSONL append and loops back into the original failure.
## Why
In Coral, normal completion, queued abort finalization, generic failure handling, workflow finalization, and backend orphan recovery all converge on terminal append helpers. Routing a failed terminal append into one of those helpers does not degrade safely; it retries the same broken write and can still leave `waitStream()` without an observable terminal outcome.
## Pattern
```typescript
// Wrong: catch append failure and route into a helper that calls appendTerminal() again
try {
  progressStore.appendTerminal(jobId, sessionId, result, phase);
} catch (error) {
  failJob(jobId, sessionId, 'error', String(error)); // failJob -> appendTerminal()
}
```

```typescript
// Right: strict append first, then a separate fallback that does not re-enter JSONL append
try {
  progressStore.appendTerminalStrict(jobId, sessionId, result, phase);
} catch (error) {
  progressStore.writeTerminalStatusFallback(jobId, result, phase, String(error));
}
```
