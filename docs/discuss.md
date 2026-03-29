# Discuss

Backend-managed multi-agent discussion with an event-sourced core. `event-log.jsonl` is the canonical record. `state.json` is a derived `PersistedDiscussSnapshot` used for fast reads and snapshot-plus-tail hydration.

## Entry Points

| Tool | Purpose |
|------|---------|
| `discuss_seed` | Persona seeding (k-DPP sampling) |
| `discuss_start` | Create session, append initial events, start control loop |
| `discuss_participate` | Manual bid or speech injection |
| `discuss_watch` | Projected watch-log envelope (not raw events) |
| `discuss_abort` | Force-end session, detach from registry |

Manual observers: an agent with no `provider` and no `model` is treated as manual. The reducer omits them from `runtime.agentRuns`, subflows skip them during automatic bid collection, and the loop pauses when a manual participant becomes the current speaker. The session resumes after `discuss_participate`.

## Architecture

Two-layer split following **Functional Core / Imperative Shell**:

| Layer | Location | Responsibility |
|-------|----------|---------------|
| **Domain (L0)** | `src/discuss/` | Pure state transitions, event definitions, projections — zero I/O |
| **Runtime (L1)** | `src/execution/discuss/` | Control loop, persistence, provider execution, live registry |

The domain snapshot has two facets:
- **state**: user-visible discussion state (agents, bids, transcript, epoch, speaker, thresholds)
- **runtime**: persisted control metadata (controlPhase, carry-forward, follow-up queue, execution bookkeeping)

The state machine validates and emits event batches. The reducer is the single replay path for materializing committed events back into state and runtime — used by both live execution and restart recovery.

## Event Flow

Domain events (defined in `src/discuss/events.ts`):

| Group | Events |
|-------|--------|
| Session lifecycle | `session.created`, `session.ended`, `session.synthesized` |
| Bidding | `bidding.opened`, `bid.submitted`, `bid.round.closed`, `participants.expelled` |
| Speech / epoch | `speech.recorded`, `speech.timed_out`, `epoch.summary.recorded` |
| Follow-up | `must_answer.carry_forward.set`, `follow_up.queue.set`, `follow_up.answered` |
| Recovery | `agent.run.bound`, `agent.job.started`, `agent.job.finished` |

Runtime flow:

1. `discuss_start` → append `session.created` + `bidding.opened` → attach live session → collect automatic bids → schedule loop
2. Bid collection skips manual participants — manual bids arrive via `discuss_participate`
3. Loop closes bidding rounds, honors `observer_wait` for pending observer bids
4. Winner speaks (automatic via provider turn, or manual via `discuss_participate`)
5. Epoch evaluation → follow-up turns → synthesis → each advances `runtime.controlPhase`

Persisted control phases: `idle` → `observer_wait` → `evaluate_epoch` → `collect_follow_up` → `synthesize`

## `discuss_watch` Contract

Envelope shape:

```json
{
  "session": "session-id",
  "status": "bidding",
  "topic": "topic text",
  "epoch": 1,
  "step": 2,
  "events": [
    { "type": "bid_resolved", "data": { "winner": "alpha", "speaker_type": "quota" }, "ts": 1773100862000 }
  ],
  "cursor": 1
}
```

The `events` array is a **projection**, not raw domain events. Emitted types: `bid_resolved`, `speech_done`, `epoch_transition`, `session_ended`.

Cursor semantics:

| Input | Output |
|-------|--------|
| Omit `cursor` | Full watch history + current total cursor |
| `cursor = N` | Events after index N |
| `cursor = total` | Empty events, same cursor |
| `cursor > total` | `invalid_cursor` |

Live sessions append projected events into an in-memory watch buffer. Polling reads serve from the live buffer when the cursor is within retained range. If no live session or cursor is older than the buffer, the runtime rebuilds from persisted events.

## Storage And Recovery

Persisted storage is source-scoped — all checkouts of the same canonical git source share:

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

- `event-log.jsonl` is authoritative
- `state.json` is a derived snapshot (optimization + restart seed)
- `discovery.json` / `summary-index.json` are source-scoped indexes

Append order: log append + `fdatasync` → reduce into snapshot → atomic `state.json` rewrite → mark source indexes dirty.

Hydration is snapshot-plus-tail: if `state.json` matches the log, use it directly; if log grew, replay only `seq > lastAppliedSeq`; if snapshot missing, rebuild from full log.

On backend startup, known discuss sources are iterated and non-abort-ended sessions are recovered with prebuilt watch buffers.

## Projections And Authority

Three projection layers:
- **Control view**: redacts bid internals (bids, effective_bids, thoughts)
- **Audit view**: full transcript (only available for ended sessions)
- **Watch events**: derived notifications for live polling

HTTP API authority:
- `/api/discuss` reads persisted summaries per canonical source
- Deduplication by canonical source + sessionId (same repo, different checkouts = one entry)
- Live sessions override persisted rows with `authority: "live"`
- `/api/discuss/detail?view=audit` returns 409 for non-ended sessions

The sealed-bid design keeps live protocol private while enabling post-hoc audit from the same projection layer.
