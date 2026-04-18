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
  content_seq: number;
  metadata_seq: number;
  last_mutation: string;
}

export interface CurateSchedulerRow {
  id: 1;
  processed_through: string | null;
  discovery_high_seq: number | null;
  discovery_offset: number | null;
  last_run_day: string | null;
  consecutive_failures: number;
  community_topology_hash: string | null;
}
