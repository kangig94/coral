# Bridge Timeout Helpers Must Enclose Body Reads
Promoted: 2026-03-09 | Updated: 2026-03-09
## Rule
When simplifying bridge/backend fetch code with a timeout helper, keep the helper responsible for the full operation that must stay deadline-bound. If the existing timeout currently stays active through `response.json()` or SSE consumption, a refactor must keep that body read inside the helper callback instead of returning `Response` early.
## Why
`AbortController` does not only guard connection setup. The same signal also applies while the response body is being consumed. A helper that clears the timer immediately after `fetch()` resolves silently removes timeout enforcement from JSON parsing or stream reads, which changes runtime behavior while looking like a harmless deduplication.
## Pattern
```typescript
// Right: the timeout stays active until the body is consumed.
async function withAbortTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

const { response, body } = await withAbortTimeout(async (signal) => {
  const response = await fetch(url, { signal });
  return { response, body: await response.json() };
});
```

```typescript
// Wrong: the timeout is cleared before body consumption.
const response = await fetchWithTimeout(url);
const body = await response.json();
```
