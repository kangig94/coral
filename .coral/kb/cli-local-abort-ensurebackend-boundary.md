# Local Wait Abort Cannot Preempt ensureBackend()
Promoted: 2026-03-15 | Updated: 2026-03-15
## Rule
In CLI or bridge wait loops, a user-triggered local abort can cancel the active `streamWait()` fetch and any abort-aware reconnect backoff, but it cannot interrupt an in-flight `ensureBackend()` call because backend resolution happens outside the fetch path and does not accept an abort signal. Check the local-abort flag before every new `ensureBackend()` and `streamWait()` attempt, treat abort cleanup as best effort, and do not promise mid-bootstrap cancellation.
## Why
It is easy to write or review a Ctrl+C plan as if one `AbortController` governs the whole reconnect loop. In Coral, that is false: `streamWait()` listens to the controller, but `ensureBackend()` can still block through startup or replacement. If the plan ignores that boundary, the implementation may launch another retry after the user already asked to abort, or bubble abort-cleanup failures out as generic transport errors.
## Pattern
```typescript
// Right: local abort stops the active fetch, cancels backoff, and blocks future attempts.
while (true) {
  if (localAbortRequested) return 1;
  const backend = await ensureBackend(pluginRoot);
  if (localAbortRequested) return 1;

  try {
    for await (const event of streamWait(jobIds, timeoutSeconds, backend, cursor, controller.signal)) {
      // ...
    }
  } catch (error) {
    if (localAbortRequested) return 1;
    await delay(500, undefined, { signal: controller.signal });
  }
}
```

```typescript
// Wrong: assume aborting the fetch also interrupts backend resolution.
const backend = await ensureBackend(pluginRoot);
for await (const event of streamWait(jobIds, timeoutSeconds, backend, cursor, controller.signal)) {
  // ...
}
```
