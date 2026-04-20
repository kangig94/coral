// Row shapes mirroring src/store/schema.sql. Compile-time check against column drift.
export interface EventsRow {
  seq: number;
  ts: string;
  type: string;
  stream_kind: 'job' | 'session' | 'discuss' | 'workflow';
  stream_id: string;
  namespace: string | null;
  project: string | null;
  correlation_id: string | null;
  causation_seq: number | null;
  refs: string | null;
  body_version: number;
  body: Uint8Array;
}

export interface MetaRow {
  key: string;
  value: string;
}

export interface CorpusStateRow {
  id: 1;
  snapshot_id: string | null;
  content_seq: number;
  metadata_seq: number;
  content_manifest_hash: string | null;
  metadata_manifest_hash: string | null;
  last_mutation: string;
}

export interface CurateSchedulerRow {
  id: 1;
  processed_through_seq: number | null;
  processed_through_entry_id: string | null;
  processed_through_entry_kind: string | null;
  discovery_high_seq: number | null;
  discovery_offset: number | null;
  last_run_day: string | null;
  consecutive_failures: number;
  community_topology_hash: string | null;
}

export interface CurateRetryQueueRow {
  entry_id: string;
  reason: string;
  observed_at: string;
  locus: string | null;
  canonical_incident: string | null;
  signals_json: string | null;
  repair_hint: string | null;
  retry_not_before: string;
  retry_count: number;
}

export interface CurateDiscoveryBacklogRow {
  entry_id: string;
  principle_slug: string;
  statement: string;
  queued_at: string;
  reason: string | null;
}

export interface CurateDiscoveryBacklogNoteRow {
  backlog_entry_id: string;
  note_id: string;
}
