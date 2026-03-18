# Backend Replacement Drops Active Wait Streams
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
Treat a backend replacement during `/wait/stream` as a transport failure unless the bridge explicitly reconnects and resumes with a cursor. Rebuilding or replacing the backend can close active SSE wait connections even when the underlying detached job is still alive.
## Why
`ensureBackend()` may shut down an older backend after a bundle hash change. The backend closes connections during shutdown, and the bridge sees undici's `TypeError("terminated")`. Without a retry-or-fail rule, callers misclassify the failure as an ordinary wait result while the job continues elsewhere.
## Pattern
```ts
// Right: classify terminated SSE as transport failure or reconnect with a cursor.
return { error: 'wait_transport_failure', message: 'terminated' };
```

```ts
// Wrong: assume the job died just because the wait stream died.
return { state: 'failed', message: 'backend restarted' };
```
