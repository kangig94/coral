# Backend Replacement Needs Shutdown Before Proxy Leader Election
## Rule
When version-mismatched backend replacement reuses the singleton `backend.lock`, the proxy cannot become the replacement leader until the live backend has already begun shutdown and released that lock. If the running backend still owns `backend.lock`, a design that says "lock winner sends shutdown" deadlocks; the workable sequence is authenticated `/admin/shutdown`, poll until the old owner releases the lock, then let one proxy briefly acquire the lock as a replacement fence before spawning the new backend.
## Why
The backend lock is owner-lifetime state, not just a restart mutex. During normal operation the live backend already holds it, so proxies cannot pre-claim leadership without conflicting with the ownership model from Phase 1. Missing this creates an impossible restart protocol where no proxy can win the lock, no one can perform replacement, and version mismatch never converges.
## Pattern
```text
WRONG
old backend healthy but version-mismatched
proxy tries to win backend.lock before shutdown
lock never becomes available because old backend still owns it
=> replacement deadlocks
```

```text
RIGHT
proxy detects healthy old backend with wrong version
proxy sends authenticated /admin/shutdown
old backend drains and releases backend.lock
one proxy briefly acquires backend.lock as replacement fence
proxy clears stale backend.json, releases the lock, spawns new backend
readiness still comes from backend.json + authenticated /health
```
