-- The journal: append-only event log
CREATE TABLE IF NOT EXISTS events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,  -- global total order
  ts             TEXT    NOT NULL,                   -- ISO 8601
  type           TEXT    NOT NULL,                   -- e.g. 'job.terminal.recorded'
  stream_kind    TEXT    NOT NULL,                   -- 'job'|'session'|'discuss'|'workflow' (four Journal kinds only; see §5)
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
  session_id              TEXT NOT NULL,
  provider                TEXT NOT NULL,
  project_root            TEXT NOT NULL,
  backend_namespace       TEXT NOT NULL,
  bundle_hash             TEXT,
  job_kind                TEXT NOT NULL,
  parent_workflow_job_id  TEXT,             -- workflow-slot parent (jobs launched by a workflow plan)
  workflow_slot           TEXT,             -- slotId on parent's plan
  created_at              TEXT NOT NULL,
  last_seq                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS projection_jobs_phase_namespace ON projection_jobs(phase, backend_namespace);
CREATE INDEX IF NOT EXISTS projection_jobs_session ON projection_jobs(session_id);
CREATE INDEX IF NOT EXISTS projection_jobs_parent ON projection_jobs(parent_workflow_job_id);

CREATE TABLE IF NOT EXISTS projection_sessions (
  session_id       TEXT PRIMARY KEY,
  controller       TEXT NOT NULL,
  provider         TEXT NOT NULL,
  resumable        INTEGER NOT NULL,
  conversation_ref TEXT,
  last_seq         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projection_discuss (
  discuss_id TEXT PRIMARY KEY,
  state      TEXT NOT NULL,        -- JSON (reducer output)
  last_seq   INTEGER NOT NULL
);

-- KB metadata projection (derived from Corpus, not Journal).
-- Refreshed by CorpusConsumer sync from markdown files; `content_seq` tracks
-- the Corpus version (see §6.4), not the Journal's events.seq.
CREATE TABLE IF NOT EXISTS projection_kb (
  entry_id    TEXT PRIMARY KEY,
  title       TEXT,
  content     TEXT,                -- cached for rebuild; Corpus markdown is authoritative
  frontmatter TEXT,                -- JSON
  content_seq INTEGER NOT NULL     -- Corpus version at last refresh
);

CREATE TABLE IF NOT EXISTS projection_workflows (
  workflow_id TEXT PRIMARY KEY,
  plan        TEXT NOT NULL,       -- JSON: { slots: [{slotId, label, provider, instruction, ...}] }
  last_seq    INTEGER NOT NULL
);

-- Metadata
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Rows: schema_version, journal_version, coordinator_id, created_ts

-- Corpus version state (KB authority - see §6.4)
-- Single row. contentSeq/metadataSeq are monotonic counters on the Corpus.
CREATE TABLE IF NOT EXISTS corpus_state (
  id            INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
  content_seq   INTEGER NOT NULL,
  metadata_seq  INTEGER NOT NULL,
  last_mutation TEXT    NOT NULL    -- ISO 8601
);

-- Equipment projection cursors (async push model; see §2.6)
-- Cursor interpretation depends on the consumer's authority:
-- - Journal consumers: cursor is events.seq
-- - Corpus consumers: cursor is corpus contentSeq (or metadataSeq)
CREATE TABLE IF NOT EXISTS equipment_cursors (
  consumer_id TEXT PRIMARY KEY,      -- 'orama-fts', 'orama-vector', 'needle-vector'
  authority   TEXT NOT NULL,         -- 'journal' | 'corpus'
  lane        TEXT,                  -- NULL for journal, 'content' | 'metadata' for corpus
  cursor      INTEGER NOT NULL,      -- last successfully-applied seq/contentSeq
  equipped_at TEXT    NOT NULL       -- ISO 8601 of most recent equip
);

-- Curate scheduler bookkeeping (replaces today's curate-state.json).
-- Single row. Worker claim is omitted (coordinator single-writer covers it);
-- migration_version is omitted (meta.schema_version handles schema evolution).
CREATE TABLE IF NOT EXISTS curate_scheduler (
  id                         INTEGER PRIMARY KEY CHECK (id = 1),
  processed_through          TEXT,                        -- JSON: CurateCursor
  discovery_high_seq         INTEGER,
  discovery_offset           INTEGER,
  last_run_day               TEXT,
  consecutive_failures       INTEGER NOT NULL DEFAULT 0,
  community_topology_hash    TEXT
);

-- Curate retry queue (pendingRepair[] in today's JSON state).
-- Each entry has its own retry schedule; indexed by retry_not_before for
-- O(log n) "who is due now" scans.
CREATE TABLE IF NOT EXISTS curate_retry_queue (
  entry_id                   TEXT PRIMARY KEY,
  reason                     TEXT NOT NULL,
  observed_at                TEXT NOT NULL,
  retry_not_before           TEXT NOT NULL,
  retry_count                INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS curate_retry_by_time ON curate_retry_queue(retry_not_before);

INSERT OR IGNORE INTO meta (key, value) VALUES
  ('schema_version', '2'),
  ('journal_version', '1'),
  ('coordinator_id', lower(hex(randomblob(16)))),
  ('created_ts', strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO corpus_state (id, content_seq, metadata_seq, last_mutation) VALUES
  (1, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO curate_scheduler (id, processed_through, discovery_high_seq, discovery_offset, last_run_day, consecutive_failures, community_topology_hash) VALUES
  (1, NULL, NULL, NULL, NULL, 0, NULL);
