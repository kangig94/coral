# Discuss Discovery Index Needs Project-Level Serialization
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
`discovery.json` is a project-wide index, so session-local append locks are not enough to protect it. Keep event-log and snapshot writes under a per-session mutex, but serialize discovery rewrites with a separate project-level lock, and keep read paths able to repair from directory scan plus `state.json` when the index lags.
## Why
Two sessions can commit durably at the same time and then race on the shared discovery file. Without a project-level lock, both commits succeed but one rewrite can drop the other's index row, which makes listing and restart look nondeterministic even though the underlying sessions were persisted correctly.
## Pattern
Right:
```ts
await withSessionLock(sessionId, appendEventLogAndSnapshot);
await withProjectDiscoveryLock(projectRoot, rewriteMergedDiscoveryIndex);
```

Wrong:
```ts
await withSessionLock(sessionA, rewriteDiscoveryIndex);
await withSessionLock(sessionB, rewriteDiscoveryIndex);
```
