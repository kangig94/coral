# Session Lock Has a TOCTOU Race Between mkdir and PID Write

## Rule
In `src/discuss/lock.ts`, the lock owner creates `state.lock/` (mkdir) first and writes `pid` second. A contender that hits `EEXIST` during this window finds `pid` missing, treats the lock as stale via `parseLockOwner → null`, and force-removes `state.lock/` — potentially evicting a live owner that is mid-execution.

## Why
The stale-detection heuristic conflates "pid file absent" with "lock is stale". But the pid file doesn't exist yet during the brief window between `mkdirSync(lockDir)` and `writeFileSync(pidFile, ...)`. Any contender that samples the lock in that window will incorrectly steal it.

## Pattern
```
Owner:     mkdirSync(lockDir)  ←── lock "acquired"
                │
Contender:      └── EEXIST → parseLockOwner → null → clearLockFiles → steal!
                │
Owner:     writeFileSync(pidFile, ...)  ←── too late
```
If this race is ever fixed, write `pid` atomically before the lock is considered acquired (e.g., via a temp file rename into `lockDir`), or add a brief retry before treating a missing-pid lock as stale.
