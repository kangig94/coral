# Wait AbortError Must Distinguish Caller Cancel From Transport Timeout
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
In the bridge `wait` handler, only map `AbortError` to an in-band `{ state: "running" }` response when the outer MCP request signal is actually aborted. `streamWait()` also uses its own abort controller for fetch and SSE timeouts, so an `AbortError` with a live outer signal must be treated as a transport failure and returned with `isError: true`.
## Why
If the bridge treats every `AbortError` as a normal poll timeout, infrastructure failures disappear into resumable-looking `running` responses. That masks broken wait streams, causes callers to keep polling a transport problem, and defeats the intended semantic split between protocol outcomes and infrastructure errors.
## Pattern
```ts
// Wrong: internal fetch aborts look like ordinary wait timeouts.
if (waitError instanceof Error && waitError.name === 'AbortError') {
  return jsonResult({ state: 'running', runningJobIds: parsed.jobs });
}
```

```ts
// Right: only caller cancellation stays in-band.
if (waitError instanceof Error && waitError.name === 'AbortError' && extra.signal.aborted) {
  return jsonResult({ state: 'running', runningJobIds: parsed.jobs });
}

return mcpError({
  error: 'wait_transport_failure',
  message: waitError instanceof Error ? waitError.message : String(waitError),
});
```
