// Row shapes mirroring src/store/schemas/*.sql. Compile-time check against column drift.
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
