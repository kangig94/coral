# Discuss

Backend-managed multi-agent discussion with an event-sourced core. The canonical record is an append-only event log; `state.json` is a derived snapshot used for fast reads and restart recovery.

## Entry Points

- `discuss_seed` generates diverse persona assignments with the k-DPP seeding logic in [`src/discuss/persona-seed.ts`](/home/dev/workspace/coral/src/discuss/persona-seed.ts).
- `discuss_start` creates a session, persists `session.created` + `bidding.opened`, and hands control to [`DiscussManager`](/home/dev/workspace/coral/src/execution/discuss-manager.ts).
- `discuss_participate` lets manual participants submit a bid or a speech without bypassing the same event pipeline.
- `discuss_watch` returns the ordered watch history derived from persisted events.
- `discuss_abort` appends a durable terminal event; aborted sessions are not resumed on restart.

## Runtime Model

The domain snapshot has two layers:

- `state`: the user-visible discussion state in [`src/discuss/types.ts`](/home/dev/workspace/coral/src/discuss/types.ts) with agents, bids, transcript, step, epoch, current speaker, thresholds, and terminal reason text.
- `runtime`: persisted control metadata in [`src/discuss/events.ts`](/home/dev/workspace/coral/src/discuss/events.ts) with `controlPhase`, carry-forward must-answer items, follow-up queue, and provider execution bookkeeping per agent.

`DiscussManager` is the imperative shell. It loads the latest snapshot from [`DiscussSessionStore`](/home/dev/workspace/coral/src/execution/discuss-session-store.ts), asks the pure deciders in [`src/discuss/state-machine.ts`](/home/dev/workspace/coral/src/discuss/state-machine.ts) for the next event batch, appends that batch through the store, then resumes the loop from the new snapshot.

Persisted control phases:

- `idle`
- `observer_wait`
- `evaluate_epoch`
- `collect_follow_up`
- `synthesize`

Those phases are what make restart recovery resumable without relying on in-memory shadow state.

## Event Flow

The event union lives in [`src/discuss/events.ts`](/home/dev/workspace/coral/src/discuss/events.ts). The main groups are:

- Session lifecycle: `session.created`, `session.ended`, `session.synthesized`
- Bidding: `bidding.opened`, `bid.submitted`, `bid.round.closed`, `participants.expelled`
- Speech and epoch progress: `speech.recorded`, `speech.timed_out`, `epoch.summary.recorded`
- Follow-up control: `must_answer.carry_forward.set`, `follow_up.queue.set`, `follow_up.answered`
- Execution recovery: `agent.run.bound`, `agent.job.started`, `agent.job.finished`

Deciders only validate and emit events. They do not mutate state directly. The reducer in [`src/discuss/reducer.ts`](/home/dev/workspace/coral/src/discuss/reducer.ts) is the single place that turns domain events back into `state` + `runtime`.

High-level loop:

1. `discuss_start` appends `session.created` and `bidding.opened`.
2. Agents or manual participants append `bid.submitted`.
3. `DiscussManager` resolves the round by appending `bid.round.closed`, and sometimes `session.ended` in the same batch for terminal no-winner outcomes.
4. The winning speaker appends `speech.recorded` or `speech.timed_out`.
5. Epoch evaluation appends `epoch.summary.recorded`, `must_answer.carry_forward.set`, `follow_up.queue.set`, and `follow_up.answered` as needed.
6. When the session finishes, synthesis is appended as `session.synthesized`.

The reducer preserves the same bidding rules as before: thresholded primary pool, fallback pool, cold start, epoch transitions, fairness-adjusted effective bids, and deterministic tiebreaks.

## Storage

Per-project storage is under:

```text
{project}/$CORAL_DATA/discuss/
├── discovery.json
└── <session-id>/
    ├── event-log.jsonl
    └── state.json
```

- `event-log.jsonl` is authoritative.
- `state.json` is a `PersistedDiscussSnapshot` with `lastAppliedSeq`.
- `discovery.json` is the per-project session index used by API listing, restart recovery, and reef cold-scan.

Append order in [`DiscussSessionStore.append()`](/home/dev/workspace/coral/src/execution/discuss-session-store.ts):

1. Append the event batch to `event-log.jsonl` and `fdatasync`.
2. Reduce the batch into the next snapshot.
3. Atomically rewrite `state.json`.
4. Atomically merge the committed session metadata into `discovery.json`.

The store also updates `~/.claude/coral/discuss-project-roots.json` so the backend can enumerate discuss roots before serving requests.

## Recovery

Recovery is snapshot-plus-tail, not snapshot-only:

- If `state.json` exists, the store replays only events with `seq > lastAppliedSeq`.
- If `state.json` is missing, it rebuilds from the full event log.
- If discovery metadata is missing or stale, the readers fall back to scanning session directories and `state.json`.

On backend startup, [`DiscussManager.recoverPersistedSessions()`](/home/dev/workspace/coral/src/execution/discuss-manager.ts) attaches all non-abort sessions found through the store and resumes any persisted control phase that still needs work. Execution recovery is driven by the persisted runtime events:

- `agent.run.bound` remembers the execution session ID after `service.start()` returns.
- `agent.job.started` remembers the in-flight job and attempt.
- `agent.job.finished` records the last terminal outcome so retries can resume after restart.

If a stored job is missing or no longer live, recovery records a failure outcome and re-runs the turn when the retry budget allows it.

## Projections And APIs

[`src/discuss/projections.ts`](/home/dev/workspace/coral/src/discuss/projections.ts) builds the read models used by the API and watch surfaces:

- `buildControlView()` redacts bid internals from transcript entries.
- `buildAuditView()` returns the full transcript.
- `buildWatchEvents()` derives `bid_resolved`, `speech_done`, `epoch_transition`, and `session_ended` notifications from committed events.

[`src/client/discuss.ts`](/home/dev/workspace/coral/src/client/discuss.ts) turns those projections into stable DTOs for backend consumers and `coral-reef`.

HTTP/API rules:

- `GET /api/discuss` lists persisted summaries from the store, with live sessions overriding authority to `live`.
- `GET /api/discuss/detail?view=control` returns redacted transcript data.
- `GET /api/discuss/detail?view=audit` returns full transcript data only after the session has ended; live audit requests return `409`.
- Every committed discuss batch emits `discuss:updated` on the execution event bus and over backend SSE.

## Sealed-Bid Surface

The control view hides `bids`, `effective_bids`, and `thoughts` from transcript entries. Those fields remain in the event log and the audit view, but they are not exposed through live detail reads. That keeps the live protocol sealed-bid while still supporting post-hoc inspection and reef indexing from the same underlying projection contract.
