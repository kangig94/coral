# Reef Discuss Transcript Projection Needs a Single Shared Builder
Promoted: 2026-03-11 | Updated: 2026-03-11
## Rule
When `coral-reef` ingests discuss data from both local disk and remote backend APIs, both paths must pass through the same shared projection/builder layer. Do not let cold-scan hand-switch over raw `DiscussState.transcript` while remote-sync separately interprets backend detail JSON. The persisted SQLite `transcript_entries` rows should come from one shared DTO/projection contract, or union cases and nesting rules will drift.
## Why
This drift is easy to miss because both ingest paths appear to “have the data,” but they drop different parts of it. In the current code, remote-sync expects a top-level `transcript` even though the backend nests it under `session`, so remote transcript rows never populate. Local cold-scan does populate transcript rows, but its manual switch omits the `follow_up` union member. The result is asymmetric discuss history depending on source, which breaks audit parity and hides bugs until the UI or sync path changes.
## Pattern
Right:
```ts
const materialized = replayDiscussSession(snapshot, events);
const detail = buildDiscussDetail(materialized, materialized.state.status === 'ended' ? 'audit' : 'control');
upsertDiscussDetail(db, detail);
```

Wrong:
```ts
// Local path hand-maps raw transcript union...
function buildTranscriptRows(state: DiscussState) {
  switch (entry.type) {
    case 'speech':
    case 'epoch_summary':
    case 'session_event':
    case 'bids':
      // follow_up silently missing
  }
}

// ...while remote path expects a different response nesting.
const transcript = detail.transcript;
```
