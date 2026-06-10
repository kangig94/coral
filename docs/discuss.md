# Discuss

Coordinator-managed multi-agent discussion with an event-sourced core. SQLite Journal events are the canonical record; `projection_discuss` is the durable read model used for snapshots, watch hydration, discovery, and summary indexes.

## Entry Points

Discuss is exposed through CLI commands and matching coordinator HTTP endpoints:

| CLI command | HTTP route | Purpose |
| --- | --- | --- |
| `coral-cli discuss seed` | `POST /discuss/persona-sets` | Persona seeding |
| `coral-cli discuss start` | `POST /discuss/sessions` | Create session, append initial events, start control loop |
| `coral-cli discuss watch` | `GET /discuss/sessions/:id/events` | Read projected watch events; local CLI reads use `read-model/CoralStore` directly |
| `coral-cli discuss participate` | `POST /discuss/sessions/:id/bids` or `POST /discuss/sessions/:id/speeches` | Inject a manual bid or speech |
| `coral-cli discuss abort` | `DELETE /discuss/sessions/:id` | End the session and detach it from the live registry |

Manual observers are agents with no `provider` and no `model`. They are skipped during automatic bid collection and the loop pauses when a manual participant becomes the current speaker.

## Architecture

Discuss keeps a strict functional-core / imperative-shell split:

| Layer | Location | Responsibility |
| --- | --- | --- |
| Domain | `src/discuss/` | Pure state transitions, event definitions, projections |
| Shell | `src/discuss/shell/` | Control loop, persistence, provider execution, live registry |

Coordinator startup/recovery and HTTP transport stay outside the discuss module; discuss-specific shell code is consumed through those coordinator and transport seams.

The persisted snapshot has two facets:

- `state`: user-visible discuss state
- `runtime`: control metadata used to resume live execution

## Event Flow

Domain events and their strict Journal body schemas are defined in `src/discuss/events.ts`; `src/discuss/store-registry.ts` registers one schema per `discuss.*` event type.

| Group | Events |
| --- | --- |
| Session lifecycle | `session.created`, `session.ended`, `session.synthesized` |
| Bidding | `bidding.opened`, `bid.submitted`, `bid.round.closed`, `participants.expelled` |
| Speech / epoch | `speech.recorded`, `speech.timed_out`, `epoch.summary.recorded` |
| Follow-up | `must_answer.carry_forward.set`, `follow_up.queue.set`, `follow_up.answered` |
| Recovery | `agent.run.bound`, `agent.job.started`, `agent.job.finished` |

`agent.job.finished` is the discuss-owned operational outcome event for provider/facilitator attempts. Outcomes include `completed`, `non_resumable`, `execution_error`, `recovery_failed`, `recovery_missing`, and `retryable_parse_error`; cause-ref rendering uses `src/discuss/event-describers.ts` through the read-model describer composition.

Runtime flow:

1. `coral-cli discuss start` / `POST /discuss/sessions` appends `session.created` and `bidding.opened`.
2. Automatic providers bid; manual participants wait for `POST /discuss/sessions/:id/bids` or `POST /discuss/sessions/:id/speeches`.
3. The loop resolves speakers, records speech, evaluates epochs, schedules follow-up turns, and eventually synthesizes.
4. `coral-cli discuss watch` reads the projected watch stream from `read-model/CoralStore`; remote HTTP callers use `GET /discuss/sessions/:id/events`.
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

Discuss storage is Journal-scoped. Events live in `events` on the `discuss/<session-id>` stream, snapshots live in `projection_discuss`, and source-scoped discovery/summary views are derived from those projections.

Hydration reads the projected snapshot plus the persisted event tail. On coordinator startup, Coral recovers known discuss sources and reattaches non-terminal sessions.

### Completed-discussion record

When a session reaches its final synthesis, the shell materializes a human-readable markdown record at `<projectDataDir>/discuss/<YYYYMMDD-HHMMSS>-<topic-slug>.md` (`projectDataDir` = `runtime.paths.projectData(projectRoot)`, alongside the project's memos). The record contains the header, participants, the full transcript (speeches, follow-ups, epoch summaries), and the final synthesis. It is a best-effort, rebuildable export of the `discuss` journal stream — the authoritative record stays in the Journal, the write is fail-isolated (a failure never breaks the discussion), and it is written only on successful synthesis (aborted/idle-ended sessions produce no file). The export lives in the project data dir, so it is not subject to the `exports/jobs` retention prune. See `src/discuss/transcript-export.ts`.

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
