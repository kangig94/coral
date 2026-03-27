# Discuss

Backend-managed multi-agent discussion with an event-sourced core. `event-log.jsonl` is the canonical record. `state.json` is a derived `PersistedDiscussSnapshot` used for fast reads and snapshot-plus-tail hydration.

## Entry Points

Schemas for the tool-facing inputs live in `src/discuss/schemas.ts` and `src/execution/server.ts`.

- `discuss_seed` runs persona seeding in `src/discuss/persona-seed.ts`.
- `discuss_start` validates input in `src/execution/server.ts`, then calls `startDiscussSession()` in `src/execution/discuss-operations.ts`.
- `discuss_participate` records a manual bid or manual speech through the same append-only event pipeline used by automated turns.
- `discuss_watch` returns a projected watch-log envelope, not raw domain events.
- `discuss_abort` force-ends a live session and detaches it from the in-memory registry.

### Manual observers

`discuss_start` treats an `observer` agent with no `provider` and no `model` as a manual participant.

- `src/execution/discuss-executor.ts` records that agent as `manual: true` in the `session.created` execution config.
- `src/discuss/reducer.ts` omits manual participants from `runtime.agentRuns`.
- `src/execution/discuss-subflows.ts` skips them during automatic bid collection.
- `src/execution/discuss-loop.ts` stops when a manual participant becomes the current speaker.

The session resumes only after `discuss_participate` appends that participant's bid or speech.

## Runtime Model

`src/execution/server.ts` imports `src/execution/discuss-operations.ts`. That file is the primary execution-layer entry for start, watch, manual participation, abort, and persisted-session attachment.

The runtime is split across focused sibling modules:

- `src/execution/discuss-loop.ts`: resumes and continues the live control loop.
- `src/execution/discuss-persistence.ts`: optimistic commit helpers, `afterCommit()` live updates, and persisted watch rebuilds.
- `src/execution/discuss-subflows.ts`: bid collection, speech collection, epoch evaluation, follow-up, and synthesis subflows.
- `src/execution/discuss-registry.ts`: attached live sessions, subscriber cursors, and watch-buffer reads.
- `src/execution/discuss-executor.ts`: provider execution config, retry bookkeeping, and manual-participant detection.
- `src/execution/discuss-context.ts`: shared runtime types, watch-buffer helpers, and runtime errors.
- `src/execution/discuss-prompts.ts`: bid and speech prompt builders.

Supporting storage and registry modules stay separate:

- `src/execution/discuss-session-store.ts`: appends committed batches and persists source-scoped indexes.
- `src/execution/discuss-context-registry.ts`: groups live discuss contexts by project root.

The domain snapshot still has two layers:

- `state` in `src/discuss/types.ts`: user-visible discussion state such as agents, bids, transcript, step, epoch, current speaker, thresholds, and terminal reason text.
- `runtime` in `src/discuss/events.ts`: persisted control metadata such as `controlPhase`, carry-forward must-answer items, follow-up queue, and provider execution bookkeeping.

Persisted control phases:

- `idle`
- `observer_wait`
- `evaluate_epoch`
- `collect_follow_up`
- `synthesize`

`src/discuss/state-machine.ts` validates and emits event batches. `src/discuss/reducer.ts` is the only place that materializes committed domain events back into `state` and `runtime`.

## Event Flow

The domain-event union lives in `src/discuss/events.ts`. The main groups are:

- Session lifecycle: `session.created`, `session.ended`, `session.synthesized`
- Bidding: `bidding.opened`, `bid.submitted`, `bid.round.closed`, `participants.expelled`
- Speech and epoch progress: `speech.recorded`, `speech.timed_out`, `epoch.summary.recorded`
- Follow-up control: `must_answer.carry_forward.set`, `follow_up.queue.set`, `follow_up.answered`
- Execution recovery: `agent.run.bound`, `agent.job.started`, `agent.job.finished`

High-level runtime flow:

1. `discuss_start` appends `session.created` and `bidding.opened`, attaches the live session, collects automatic bids, and schedules the loop.
2. `src/execution/discuss-subflows.ts` collects bids only for non-manual participants. Manual bids arrive through `discuss_participate`.
3. `src/execution/discuss-loop.ts` closes bidding rounds and honors `observer_wait` when observer bids may still arrive.
4. Automatic winners speak through `collectSpeech()`. If the winner is manual, the loop returns and waits for `discuss_participate` to append `speech.recorded`.
5. Epoch evaluation, follow-up turns, and synthesis append their own committed batches and advance `runtime.controlPhase`.

The reducer preserves the sealed-bid discussion rules while keeping the write path event-sourced.

## `discuss_watch` Contract

`discuss_watch` returns this envelope shape:

```json
{
  "session": "session-id",
  "status": "bidding",
  "topic": "topic text",
  "epoch": 1,
  "step": 2,
  "events": [
    {
      "type": "bid_resolved",
      "data": {
        "winner": "alpha",
        "speaker_type": "quota"
      },
      "ts": 1773100862000
    }
  ],
  "cursor": 1
}
```

The `events` array is a projection from `src/discuss/projections.ts`, not a dump of raw domain events. The emitted watch event types are:

- `bid_resolved`: `{ winner, speaker_type }`
- `speech_done`: `{ speaker, content }`
- `epoch_transition`: `{ epoch }`
- `session_ended`: `{ reason, detail? }`

Cursor semantics:

- The cursor is the projected watch-event count, not the domain-event `seq`.
- Omitting `cursor` returns the full available watch history and the current total cursor.
- Passing `cursor = N` returns only events after index `N` in the projected watch history.
- Passing `cursor` equal to the current total returns `events: []` and the same cursor.
- Passing `cursor` greater than the current total returns `invalid_cursor`.

Live-buffer versus persisted rebuild:

- Live sessions append projected watch events into the in-memory `watchBuffer` in `src/execution/discuss-persistence.ts` via `afterCommit()`.
- `src/execution/discuss-registry.ts` serves polling reads directly from that live buffer when the requested cursor is still inside the retained live range.
- If there is no live session, if the caller omits `cursor` after live-buffer compaction, or if the requested cursor is older than `watchBuffer.baseCursor`, the runtime rebuilds the response from persisted events with `buildPersistedWatchState()`.
- Both paths return the same envelope shape and cursor contract.

## Storage And Recovery

Persisted discuss storage is source-scoped. All checkouts of the same canonical git source share:

```text
~/.coral/
├── discuss-sources.json
└── projects/
    └── <source-slug>/
        └── discuss/
            ├── discovery.json
            ├── summary-index.json
            └── <session-id>/
                ├── event-log.jsonl
                └── state.json
```

- `event-log.jsonl` is authoritative.
- `state.json` stores the derived `PersistedDiscussSnapshot`, including `lastAppliedSeq`.
- `discovery.json` is the source-scoped recovery index.
- `summary-index.json` is the source-scoped listing index used by HTTP reads.
- `projectRoot` remains last-known checkout metadata. It is not the persisted storage identity.

Append order in `src/execution/discuss-session-store.ts`:

1. Append the batch to `event-log.jsonl` and `fdatasync`.
2. Reduce the batch into the next snapshot.
3. Atomically rewrite `state.json`.
4. Mark source indexes dirty so `discovery.json`, `summary-index.json`, and `~/.coral/discuss-sources.json` are flushed from committed state.

Hydration is snapshot-plus-tail, not snapshot-only:

- If `state.json` exists and the recorded log size still matches, the store returns it directly.
- If the log grew, the store replays only events with `seq > lastAppliedSeq`.
- If `state.json` is missing or stale, the store rebuilds from the full event log.

On backend startup, `src/execution/server.ts` iterates known discuss sources and calls `recoverPersistedSessionsFromStore()` in `src/execution/discuss-operations.ts`. That recovery path reads the persisted event log, skips abort-ended sessions, and attaches live sessions with a prebuilt watch buffer. It does not rely on a separate manager file.

## Projections, Authority, And HTTP APIs

`src/discuss/projections.ts` owns the shared read models:

- `buildControlView()` redacts bid internals from transcript entries.
- `buildAuditView()` returns the full transcript.
- `buildWatchEvents()` derives the watch-log notifications from committed domain events.

`src/client/discuss.ts` wraps those projections into stable summary and detail DTOs with `authority: "persisted" | "live"` and `view: "control" | "audit"`.

Authority semantics:

- `/api/discuss` reads persisted summaries per canonical source, not per checkout path.
- The server dedupes by canonical source plus `sessionId`, so the same session does not appear twice just because two checkouts point at the same repo.
- If an attached live session exists for that same canonical-source and `sessionId` pair, the live summary overrides the persisted row and `authority` becomes `live`.
- `/api/discuss/detail` applies the same rule: it resolves the requested `projectRoot` to its canonical source, loads the snapshot from that source store, and reports `authority: "live"` whenever a matching live session is attached for that source/session pair.

Detail view rules in `src/execution/server.ts`:

- `GET /api/discuss/detail` defaults to `view=control`.
- `GET /api/discuss/detail?view=control` returns the redacted transcript view.
- `GET /api/discuss/detail?view=audit` returns the full transcript only when `state.status === "ended"`.
- Requests for `view=audit` against any non-ended session, including live sessions, return `409 {"error":"audit_requires_ended_session"}`.
- Every committed discuss batch emits `discuss:updated` on the execution event bus and backend SSE, and detail reads expose the matching `lastSeq`.

## Sealed-Bid Surface

The control view hides `bids`, `effective_bids`, and `thoughts` from transcript entries. Those fields remain in the event log and in the audit view, but they are not exposed through control reads. That keeps the live protocol sealed-bid while still allowing post-hoc audit and same-source indexing from the same projection layer.
