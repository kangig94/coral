export interface KbCorpusStateRow {
  id: 1;
  snapshot_id: string | null;
  content_seq: number;
  metadata_seq: number;
  content_manifest_hash: string | null;
  metadata_manifest_hash: string | null;
  last_mutation: string;
}

export interface KbCurateSchedulerRow {
  id: 1;
  processed_through_seq: number | null;
  processed_through_entry_id: string | null;
  processed_through_entry_kind: string | null;
  discovery_high_seq: number | null;
  discovery_offset: number | null;
  last_run_day: string | null;
  last_attempted_through_seq: number | null;
  last_attempted_through_entry_id: string | null;
  last_attempted_through_entry_kind: string | null;
  retry_not_before: string | null;
  consecutive_claim_failures: number;
  consecutive_community_batch_failures: number;
  claim_lane_disabled_at: string | null;
  community_batch_lane_disabled_at: string | null;
  community_topology_hash: string | null;
  community_summary_topology_hash: string | null;
  initialized: number;
}

export interface KbCurateActiveClaimRow {
  id: 1;
  through_seq: number;
  through_entry_id: string;
  through_entry_kind: string;
  started_at: string;
}

export interface KbCurateCommunitySummaryInputFingerprintRow {
  community_slug: string;
  fingerprint: string;
}

export interface KbCurateRetryQueueRow {
  entry_id: string;
  entry_seq: number | null;
  reason: string;
  observed_at: string;
  observed_content_hash: string | null;
  locus: string | null;
  canonical_incident: string | null;
  signals_json: string | null;
  repair_hint: string | null;
  retry_not_before: string;
  retry_count: number;
}

export interface KbCurateConflictQuarantineRow {
  entry_id: string;
  entry_kind: string;
  slug: string;
  path: string;
  recovery_ref: string;
  detected_at: string;
}

export interface KbCurateDiscoveryBacklogRow {
  entry_id: string;
  principle_slug: string;
  statement: string;
  queued_at: string;
  reason: string | null;
}

export interface KbCurateDiscoveryBacklogNoteRow {
  backlog_entry_id: string;
  note_id: string;
}
