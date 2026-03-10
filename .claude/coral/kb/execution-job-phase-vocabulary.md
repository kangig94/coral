# Execution Job Phase Vocabulary
Promoted: 2026-03-10 | Updated: 2026-03-10
## Rule
Anything that filters or asserts execution job phases must use the exact persisted `JobPhase` literals: `queued`, `launching`, `running`, `completed`, `error`, and `aborted`. Do not invent synonyms like `complete`, because the `/api/jobs?phase=` route filters by exact string equality on `status.phase`.
## Why
When a caller or test uses the wrong literal, the collection route returns zero matches and looks like a routing or persistence bug even though the route is working correctly. The failure mode is subtle because `/api/jobs` and `/api/jobs/:id` still work, so only the filtered collection appears broken.
## Pattern
Right:
```ts
progressStore.initJob('job-running', 'session-1', 'codex', projectRoot, undefined, 'running');
progressStore.initJob('job-queued', 'session-2', 'codex', projectRoot, undefined, 'queued');
progressStore.appendTerminal('job-done', 'session-3', { content: 'done' }, 'completed');

await fetch('/api/jobs?phase=running');
await fetch('/api/jobs?phase=completed');
```

Wrong:
```ts
await fetch('/api/jobs?phase=complete');
// returns no matches because "complete" is not a persisted JobPhase literal
```
