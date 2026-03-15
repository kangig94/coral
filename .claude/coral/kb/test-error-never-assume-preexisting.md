# Test Errors Must Be Investigated, Never Assumed Pre-existing
Promoted: 2026-03-15 | Updated: 2026-03-15
## Rule
When test suite reports errors (including "unhandled errors" outside test assertions), always trace the stack, check if affected code was modified recently, and determine root cause before proceeding. Never label errors as "pre-existing" without verification. If the error is fixable, fix it immediately.
## Why
Dismissing test errors as "pre-existing" without investigation masks real bugs. In a real incident, `writeSseEvent()` lacked a `res.writableEnded` guard — a 1-line fix — but was ignored across 4+ test runs because the error was assumed to be a teardown artifact. Unverified assumptions about error provenance violate both "Don't Assume" and "Goal-Driven Execution" principles.
## Pattern
Right:
```
# See error in test output → trace the stack
# server.ts:926 writeSseEvent → write after end
# → check: was server.ts modified recently?
# → read the function, identify missing guard
# → fix: if (res.writableEnded) return;
# → rerun tests → 0 errors
```

Wrong:
```
# See error in test output
# "This is a pre-existing teardown error, ignoring"
# → proceed without investigation
# → error persists across all subsequent test runs
```
