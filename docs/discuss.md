# Discuss

Backend-managed multi-agent discussion with an event-sourced core. `event-log.jsonl` is the canonical record. `state.json` is a derived snapshot used for fast reads and snapshot-plus-tail hydration.

## Entry Points

Discuss is exposed through CLI commands backed by dedicated HTTP endpoints:

| CLI command | HTTP route | Purpose |
| --- | --- | --- |
| `coral-cli discuss seed` | `POST /discuss/persona-sets` | Persona seeding |
| `coral-cli discuss start` | `POST /discuss/sessions` | Create session, append initial events, start control loop |
| `coral-cli discuss watch` | `GET /discuss/sessions/:id/events` | Read projected watch events |
| `coral-cli discuss participate` | `POST /discuss/sessions/:id/bids` or `POST /discuss/sessions/:id/speeches` | Inject a manual bid or speech |
| `coral-cli discuss abort` | `DELETE /discuss/sessions/:id` | End the session and detach it from the live registry |

Manual observers are agents with no `provider` and no `model`. They are skipped during automatic bid collection and the loop pauses when a manual participant becomes the current speaker.

## Architecture

Discuss keeps a strict functional-core / imperative-shell split:

| Layer | Location | Responsibility |
| --- | --- | --- |
| Domain | `src/discuss/` | Pure state transitions, event definitions, projections |
| Runtime | `src/execution/discuss/` | Control loop, persistence, provider execution, live registry |

The persisted snapshot has two facets:

- `state`: user-visible discuss state
- `runtime`: control metadata used to resume live execution

## Event Flow

Domain events are defined in `src/discuss/events.ts`.

| Group | Events |
| --- | --- |
| Session lifecycle | `session.created`, `session.ended`, `session.synthesized` |
| Bidding | `bidding.opened`, `bid.submitted`, `bid.round.closed`, `participants.expelled` |
| Speech / epoch | `speech.recorded`, `speech.timed_out`, `epoch.summary.recorded` |
| Follow-up | `must_answer.carry_forward.set`, `follow_up.queue.set`, `follow_up.answered` |
| Recovery | `agent.run.bound`, `agent.job.started`, `agent.job.finished` |

Runtime flow:

1. `coral-cli discuss start` / `POST /discuss/sessions` appends `session.created` and `bidding.opened`.
2. Automatic providers bid; manual participants wait for `POST /discuss/sessions/:id/bids` or `POST /discuss/sessions/:id/speeches`.
3. The loop resolves speakers, records speech, evaluates epochs, schedules follow-up turns, and eventually synthesizes.
4. `coral-cli discuss watch` reads the projected watch stream from `GET /discuss/sessions/:id/events`.
5. `coral-cli discuss abort` / `DELETE /discuss/sessions/:id` appends a durable terminal event and detaches the live session.

Persisted control phases are `idle`, `observer_wait`, `evaluate_epoch`, `collect_follow_up`, and `synthesize`.

## `watch` Contract

`coral-cli discuss watch` returns a projected envelope, not raw domain events:

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

Cursor rules:

| Input | Output |
| --- | --- |
| omit `cursor` | full watch history plus current cursor |
| `cursor = N` | events after `N` |
| `cursor = total` | empty `events`, same cursor |
| `cursor > total` | `invalid_cursor` |

## Storage and Recovery

Discuss storage is source-scoped:

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
- `state.json` is the derived snapshot
- source indexes are rebuilt or marked dirty as sessions change

Hydration uses snapshot-plus-tail replay. On backend startup, Coral recovers known discuss sources and reattaches non-terminal sessions.

## Projections and Authority

Discuss exposes three read models:

- control view
- audit view
- watch-event projection

HTTP read APIs:

- `GET /discuss/sessions`
- `GET /discuss/sessions/:id?view=control|audit`
- `GET /discuss/sessions/:id/events`

Live sessions override persisted summaries with `authority: "live"`. Audit detail is only available for ended sessions.
