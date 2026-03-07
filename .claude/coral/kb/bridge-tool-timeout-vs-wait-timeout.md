# Bridge Fetch Timeout Derived from Wait timeout_seconds

## Rule
`streamWait` in `backend-client.ts` computes its fetch abort timeout from the caller's `timeout_seconds`: `min(timeoutSeconds * 1000 + 30s margin, 30min cap)`. The 30s margin gives the backend time to send its timeout SSE event before the bridge aborts the fetch. `TOOL_TIMEOUT_MS` (5 min) is kept only for `proxyToolCall`.

## Why
Previously `TOOL_TIMEOUT_MS` was a hard 5-minute fetch abort applied to `streamWait` too, independent of `timeout_seconds`. Users setting `timeout_seconds: 1200` (20 min) saw the bridge cut the connection at 5 minutes and return `{ state: "running" }`, causing unnecessary re-wait loops.

## Pattern
```typescript
// RIGHT: fetch timeout derived from user timeout
const fetchTimeoutMs = Math.min(
  (timeoutSeconds ?? 600) * 1000 + WAIT_FETCH_MARGIN_MS,  // 30s margin
  MAX_WAIT_FETCH_TIMEOUT_MS,                                // 30min cap
);

// WRONG: hardcoded fetch timeout independent of user timeout
const fetchTimeoutMs = TOOL_TIMEOUT_MS;  // 5min regardless of timeout_seconds
```
