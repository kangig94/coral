# Backend Lock Readiness Must Be Self-Verifying
## Rule
If a singleton lock can enter a `ready` state, that state must be verifiable from the lock's own data or from an artifact that is guaranteed visible before `ready` is published. A contender must never need auth or port data from a second file that may still be stale or missing in order to decide whether a `ready` owner is alive.

## Why
A two-file startup sequence like `acquire lock -> listen -> mark lock ready -> write backend info` creates a split-brain window. During that window, a contender sees a `ready` lock but cannot authenticate the owner's health because the token/port still live only in the not-yet-updated info file. That turns a healthy owner into an ambiguous one and makes stale-recovery logic destructive.

## Pattern
```text
WRONG
lock = { instanceId, state: "ready" }
backend.json = { port, token }  // written after ready
contender sees ready lock -> needs backend.json to authenticate owner -> file stale/missing -> steals lock
```

```text
RIGHT
lock ownership is acquired once and remains authoritative
readiness is proven by data that is already durable when published
contender reuses owner only when the same durable artifact is complete enough to verify health safely
```
