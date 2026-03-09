type AgentScoreMap = Record<string, number>;
type NullableAgentScoreMap = Record<string, number | null>;
type SpeakerType = 'quota' | 'fallback' | 'cold_start';
type TranscriptResolveType = 'normal' | 'fallback' | 'cold_start' | 'no_winner';
type TranscriptStepMetadata = {
  step: number;
  epoch: number;
  ts: string;
};
type TranscriptEpochMetadata = {
  epoch: number;
  ts: string;
};

export type TranscriptEntry =
  | ({
    type: 'bids';
    bids: AgentScoreMap;
    effective_bids?: AgentScoreMap;
    thoughts?: Record<string, string>;
    winner: string | null;
    resolve_type: TranscriptResolveType;
  } & TranscriptStepMetadata)
  | ({ type: 'speech'; agent: string; display_name: string; content: string; } & TranscriptStepMetadata)
  | ({ type: 'epoch_summary'; summary: string; } & TranscriptEpochMetadata)
  | ({ type: 'session_event'; event: 'force_end' | 'synthesis'; detail: string; } & TranscriptEpochMetadata);

export type AgentState = {
  persona: string;
  display_name: string;
  participation: 'required' | 'observer';
  quota_remaining: number;
  total_speaks: number;
  fallback_used: boolean;
  banned: boolean;
};

export type DiscussState = {
  session_id: string;
  topic: string;
  status: 'setup' | 'bidding' | 'speaking' | 'ended';
  step: number;
  epoch: number;
  max_epochs: number;
  quota_per_epoch: number;
  cold_start: boolean;
  agents: Record<string, AgentState>;
  current_bids: NullableAgentScoreMap;
  current_thoughts: Record<string, string>;
  pending_bidders: string[];
  current_speaker: string | null;
  speaker_type: SpeakerType | null;
  epoch_summary_written: number | null;
  created_at: string;
  last_activity_at: string;
  last_speech_step: number;
  pending_since_ts: number | null;
  bid_release_step: number;
  end_reason_content: string | null;
  transcript: TranscriptEntry[];
  bid_threshold: number;
  min_bid_delay_ms: number;
};

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; detail?: Record<string, unknown> };

export type ResolveReason =
  | 'all_below_threshold'
  | 'max_epochs_reached'
  | 'all_blocked'
  | 'epoch_transition';

/**
 * Sealed-bid design: individual bid scores are never returned to any caller.
 * The audit trail (all_bids) lives in transcript entries only.
 */
export type ResolveResult =
  | { winner: string; step?: never; speaker_type: SpeakerType }
  | { no_winner: true; reason: ResolveReason };

export type BidResult =
  | { action: 'speak' }
  | { action: 'listen'; speaker: string; content: string }
  | { action: 'listen'; speaker: null; content: string }
  | { action: 'session_ended'; reason?: string; content?: string };

export type EndReason =
  | 'all_below_threshold'
  | 'max_epochs_reached'
  | 'all_blocked'
  | 'no_participants'
  | 'already_ended';

export type DiscussCreateInput = {
  topic: string;
  agents: {
    name: string;
    persona: string;
    participation: 'required' | 'observer';
  }[];
  min_bid_delay_ms: number;
};

export type StepPhase =
  | { status: 'setup'; phase: 'not_ready' }
  | { status: 'bidding'; phase: 'bidding'; pending_bidders: string[]; pending_since_ts: number | null }
  | { status: 'bidding'; phase: 'resolved'; winner: string }
  | { status: 'bidding'; phase: 'epoch_transition'; epoch: number }
  | { status: 'bidding'; phase: 'ended'; reason: EndReason }
  | { status: 'bidding'; phase: 'expelled'; agents: string[]; hint: string }
  | { status: 'speaking'; phase: 'speech_done'; speaker: string; content: string }
  | { status: 'speaking'; phase: 'speech_pending'; elapsed: number }
  | { status: 'speaking'; phase: 'speech_timeout'; speaker: string }
  | { status: 'error'; phase: 'state_corrupt'; message: string }
  | { status: 'ended'; phase: 'ended'; reason: EndReason };

export type PersonaSeedInput = {
  demographics?: DemographicsInput;
  controversy_axes: ControversyAxis[];
  n: number;
  seed: number;
};

export type PersonaSeedOutput = {
  seed_used: number;
  sigma_used: number;
  pool_size: number;
  subsampled?: boolean;
  original_pool_size?: number;
  assignments: PersonaAssignment[];
};

export type ControversyAxis = {
  axis: string;
  positions: string[];
};

export type ToneAssignment = {
  formality: 'formal' | 'conversational';
  evidence: 'data-driven' | 'narrative';
  pace: 'concise' | 'detailed';
};

/** Weighted origin distribution for persona diversity (e.g., geographic, institutional). */
export type DemographicsInput = {
  origin_weights: Record<string, number>;
  outlier_ratio?: number;
};

export type PersonaAssignment = {
  positions: Record<string, string>;
  tone: ToneAssignment;
  persona_seed: number;
  shared_position_with?: number;
  suggested_origin?: string;
  is_outlier?: boolean;
};
