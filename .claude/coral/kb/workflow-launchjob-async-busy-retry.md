# Workflow LaunchJob Queue Semantics

## Rule
When capacity is full, `coralDispatch` returns `{ status: "queued" }` — not a rejection and not a `CliBusyError`. Treat `status: "queued"` as a successful launch outcome identical to `status: "running"`. The atom will auto-execute when a slot frees; `waitForAtoms` handles the queued-to-running transition transparently via `type: 'queued'` wait events.

## Why
The job queue system (added in 0.4.x) moves capacity pressure handling from the workflow layer into the execution engine. Before this change, `launchAtomWithRetry` used a bounded backoff retry loop to handle `busy` responses. That loop is now removed. Keeping a retry loop or treating 'queued' as an error creates a false failure path and prevents queued atoms from executing at all.

## Pattern
Right (current):
```text
coralDispatch -> decision.status === 'queued' -> return LaunchedAtom immediately
waitForAtoms sees type:'queued' events -> updates lastActivityAt -> atom eventually transitions to terminal
```

Wrong (removed pattern):
```text
launch atom -> awaitLaunch returns 'busy' -> retry with backoff N times -> throw if exhausted
# CliBusyError from spawnCli never reaches this path now; queue handles it upstream
```
