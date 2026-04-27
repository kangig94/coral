-- The journal: append-only event log
CREATE TABLE IF NOT EXISTS events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,  -- global total order
  ts             TEXT    NOT NULL,                   -- ISO 8601
  type           TEXT    NOT NULL,                   -- e.g. 'job.terminal.recorded'
  stream_kind    TEXT    NOT NULL,                   -- 'job'|'session'|'discuss'|'workflow' (the four Journal stream kinds)
  stream_id      TEXT    NOT NULL,
  namespace      TEXT,
  project        TEXT,
  correlation_id TEXT,
  causation_seq  INTEGER,                            -- FK to events(seq), loose
  refs           TEXT,                               -- JSON: { jobId?, sessionId?, parentJobId?, ... }
  body_version   INTEGER NOT NULL DEFAULT 1,         -- per-type schema version
  body           BLOB    NOT NULL                    -- JSON payload
);
CREATE INDEX IF NOT EXISTS events_stream ON events(stream_kind, stream_id, seq);
CREATE INDEX IF NOT EXISTS events_type ON events(type, seq);
CREATE INDEX IF NOT EXISTS events_refs_parent ON events(json_extract(refs, '$.parentJobId'), seq);

-- Projection tables (read models). Rebuildable from events.
-- projection_jobs is the materialized read model: identity fields that are
-- set at launch and immutable over the job lifetime live here so /jobs list
-- and namespace filters are single-query operations. Events remain
-- authoritative; projection is derived via reducer + rebuildProjections.
CREATE TABLE IF NOT EXISTS projection_jobs (
  job_id                  TEXT PRIMARY KEY,
  phase                   TEXT NOT NULL,
  terminal                TEXT,            -- JSON { outcome, durationMs } or NULL
  diagnostics             TEXT,
  session_id              TEXT,
  provider                TEXT,
  project_root            TEXT NOT NULL,
  coordinator_namespace       TEXT NOT NULL,
  bundle_hash             TEXT,
  job_kind                TEXT NOT NULL,
  parent_workflow_job_id  TEXT,             -- workflow-slot parent (jobs launched by a workflow plan)
  workflow_slot           TEXT,             -- slotId on parent's plan
  created_at              TEXT NOT NULL,
  last_seq                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS projection_jobs_phase_namespace ON projection_jobs(phase, coordinator_namespace);
CREATE INDEX IF NOT EXISTS projection_jobs_session ON projection_jobs(session_id);
CREATE INDEX IF NOT EXISTS projection_jobs_parent ON projection_jobs(parent_workflow_job_id);

CREATE TABLE IF NOT EXISTS projection_sessions (
  session_id       TEXT PRIMARY KEY,
  controller       TEXT NOT NULL,
  provider         TEXT NOT NULL,
  resumable        INTEGER NOT NULL,
  conversation_ref TEXT,
  scope_key        TEXT NOT NULL,
  entry            TEXT NOT NULL,
  last_seq         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projection_discuss (
  discuss_id TEXT PRIMARY KEY,
  state      TEXT NOT NULL,        -- JSON (reducer output)
  last_seq   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projection_workflows (
  workflow_id TEXT PRIMARY KEY,
  plan        TEXT NOT NULL,       -- JSON: { slots: [{slotId, provider, instruction, agent?, dependencies}] }
                                   -- labels are derived at render time from `slot.agent`;
                                   -- workflowId is event.stream.id, not stored in body.
  last_seq    INTEGER NOT NULL
);

-- Metadata
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Rows: schema_version, journal_version, coordinator_id, created_ts

-- Corpus version state (owned by KB authority).
-- Single row. contentSeq/metadataSeq are monotonic counters on the Corpus.
CREATE TABLE IF NOT EXISTS kb_corpus_state (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
  snapshot_id            TEXT,
  content_seq            INTEGER NOT NULL,
  metadata_seq           INTEGER NOT NULL,
  content_manifest_hash  TEXT,
  metadata_manifest_hash TEXT,
  last_mutation          TEXT    NOT NULL    -- ISO 8601
);

-- Consumer cursor table — tracks every registered consumer (default and expansion-owned) per authority.
-- Cursor interpretation depends on the consumer's authority:
-- - Journal consumers: cursor is events.seq
-- - Corpus consumers: snapshot_id + seq/hash fields reflect the last applied snapshot
CREATE TABLE IF NOT EXISTS consumer_cursors (
  consumer_id            TEXT PRIMARY KEY,      -- 'orama-fts', 'orama-vector', 'needle-vector'
  authority              TEXT NOT NULL,         -- 'journal' | 'corpus'
  lane                   TEXT,                  -- lane hint; NULL for journal and 'both' corpus consumers
  corpus_interest        TEXT,                  -- NULL for journal, 'content' | 'metadata' | 'both' for corpus
  cursor                 INTEGER,               -- journal only (events.seq)
  snapshot_id            TEXT,                  -- corpus only
  content_seq            INTEGER,               -- corpus only
  metadata_seq           INTEGER,               -- corpus only
  content_manifest_hash  TEXT,                  -- corpus only
  metadata_manifest_hash TEXT,                  -- corpus only
  registered_at          TEXT    NOT NULL,      -- ISO 8601 of most recent registration
  registration_kind      TEXT    NOT NULL DEFAULT 'base'
);

CREATE TABLE IF NOT EXISTS expansion_state (
  id           TEXT PRIMARY KEY,
  version      TEXT NOT NULL,
  installed_at TEXT NOT NULL
);

-- Curate scheduler bookkeeping.
-- Single row for scalar scheduler state; the active claim lives in kb_curate_active_claim.
CREATE TABLE IF NOT EXISTS kb_curate_scheduler (
  id                         INTEGER PRIMARY KEY CHECK (id = 1),
  processed_through_seq      INTEGER,
  processed_through_entry_id TEXT,
  processed_through_entry_kind TEXT,
  discovery_high_seq         INTEGER,
  discovery_offset           INTEGER,
  last_run_day               TEXT,
  last_attempted_through_seq INTEGER,
  last_attempted_through_entry_id TEXT,
  last_attempted_through_entry_kind TEXT,
  retry_not_before           TEXT,
  consecutive_claim_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_community_batch_failures INTEGER NOT NULL DEFAULT 0,
  community_topology_hash    TEXT,
  community_summary_topology_hash TEXT,
  initialized                INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0, 1))
);

CREATE TABLE IF NOT EXISTS kb_curate_active_claim (
  id                         INTEGER PRIMARY KEY CHECK (id = 1),
  through_seq                INTEGER NOT NULL CHECK (through_seq > 0),
  through_entry_id           TEXT NOT NULL,
  through_entry_kind         TEXT NOT NULL,
  started_at                 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kb_curate_community_summary_input_fingerprints (
  community_slug             TEXT PRIMARY KEY,
  fingerprint                TEXT NOT NULL
);

-- Curate retry queue.
-- Each entry has its own retry schedule; indexed by retry_not_before for
-- O(log n) "who is due now" scans.
CREATE TABLE IF NOT EXISTS kb_curate_retry_queue (
  entry_id                   TEXT PRIMARY KEY,
  entry_seq                  INTEGER,
  reason                     TEXT NOT NULL,
  observed_at                TEXT NOT NULL,
  observed_content_hash      TEXT,
  locus                      TEXT,
  canonical_incident         TEXT,
  signals_json               TEXT,
  repair_hint                TEXT,
  retry_not_before           TEXT NOT NULL,
  retry_count                INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS kb_curate_retry_by_time ON kb_curate_retry_queue(retry_not_before);

CREATE TABLE IF NOT EXISTS kb_curate_discovery_backlog (
  entry_id                   TEXT PRIMARY KEY,
  principle_slug            TEXT NOT NULL,
  statement                 TEXT NOT NULL,
  queued_at                 TEXT NOT NULL,
  reason                    TEXT,
  UNIQUE(principle_slug, statement)
);

CREATE TABLE IF NOT EXISTS kb_curate_discovery_backlog_notes (
  backlog_entry_id          TEXT NOT NULL REFERENCES kb_curate_discovery_backlog(entry_id) ON DELETE CASCADE,
  note_id                   TEXT NOT NULL,
  PRIMARY KEY(backlog_entry_id, note_id)
);

INSERT OR IGNORE INTO meta (key, value) VALUES
  ('schema_version', '1'),
  ('journal_version', '1'),
  ('coordinator_id', lower(hex(randomblob(16)))),
  ('created_ts', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO kb_corpus_state (
  id,
  snapshot_id,
  content_seq,
  metadata_seq,
  content_manifest_hash,
  metadata_manifest_hash,
  last_mutation
) VALUES
  (1, NULL, 0, 0, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO kb_curate_scheduler (
  id,
  processed_through_seq,
  processed_through_entry_id,
  processed_through_entry_kind,
  discovery_high_seq,
  discovery_offset,
  last_run_day,
  last_attempted_through_seq,
  last_attempted_through_entry_id,
  last_attempted_through_entry_kind,
  retry_not_before,
  consecutive_claim_failures,
  consecutive_community_batch_failures,
  community_topology_hash,
  community_summary_topology_hash,
  initialized
) VALUES
  (1, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, 0);
