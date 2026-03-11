# Discuss Shadow Snapshots Are Not Restart Semantics
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
Treat write-behind `state.json` snapshots in backend-managed discuss as audit and cold-start artifacts, not as proof that the session can resume after restart. If the execution loop still depends on runtime-only fields outside `DiscussState` such as pending follow-up queues, live job handles, watch logs, or abort state, restartability requires persisting those semantics explicitly or deriving them from an append-only event log.
## Why
A snapshot can preserve transcript and high-level state while still losing the information needed to continue the loop correctly. That creates the most dangerous failure mode: the system appears durable, but resumed sessions silently skip queued follow-ups, lose in-flight ownership, or rebuild a different control flow from the one that was actually running.
## Pattern
Right:
```ts
// Snapshot is for history/query.
writeStateShadow(session.state);

// Restart logic also persists or replays loop semantics.
persistControlEvent({ kind: 'must_answer_enqueued', items });
persistControlEvent({ kind: 'agent_run_attached', agent, providerSessionId });
```

Wrong:
```ts
// Assumes this alone makes discuss resumable.
writeFileSync('state.json', JSON.stringify(session.state));
// runtime-only queues stay in memory
session.mustAnswerQueue = evaluation.mustAnswer;
```
