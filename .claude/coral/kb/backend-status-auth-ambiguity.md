# Backend Status Auth Ambiguity
## Rule
A user-facing backend status helper must not silently collapse `/health` `401 unauthorized` into `not_running` unless that behavior is explicitly documented and accepted. For lifecycle tools, `unauthorized` and `not running` are observably different states and should usually be surfaced separately.
## Why
The backend checks the auth token before lifecycle state, so a stale `backend.json` token can produce `401` while a daemon is still reachable. Reporting that as "Backend is not running" hides a real state mismatch and makes management-plane behavior harder to reason about during replacement or token races.
## Pattern
Right:
```ts
if (response.status === 401) {
  return { ok: false, reason: 'unauthorized' };
}
if (response.status === 503) {
  return { status: 'shutting_down' };
}
```

Wrong:
```ts
if (!response.ok) return null; // 401 becomes "not running"
```
