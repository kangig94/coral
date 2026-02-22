/**
 * Shared types for the discuss MCP server.
 * Pure data - zero imports from node: or project modules.
 */

type AgentScoreMap = Record<string, number>;
type NullableAgentScoreMap = Record<string, number | null>;
type TranscriptStepMetadata = {
  step: number;
  epoch: number;
  ts: string;
};
type TranscriptEpochMetadata = {
  epoch: number;
  ts: string;
};

// ─── Transcript entries (discriminated union) ────────────────────────────────

export type TranscriptEntry =
  | ({ type: 'bids'; bids: AgentScoreMap; effective_bids?: AgentScoreMap; winner: string | null;
    resolve_type: 'normal' | 'fallback' | 'cold_start' | 'no_winner'; } & TranscriptStepMetadata)
  | ({ type: 'speech'; agent: string; display_name: string; content: string; } & TranscriptStepMetadata)
  | ({ type: 'epoch_summary'; summary: string; } & TranscriptEpochMetadata)
  | ({ type: 'session_event'; event: 'force_end' | 'synthesis'; detail: string; } & TranscriptEpochMetadata);

// ─── AgentState ─────────────────────────────────────────────────────────────

export type AgentState = {
  persona: string;
  display_name: string;
  quota_remaining: number;
  total_speaks: number;
  fallback_used: boolean;
  banned: boolean;
};

// ─── DiscussState ─────────────────────────────────────────────────────────────

export type DiscussState = {
  session_id: string;
  session_dir: string;
  topic: string;
  status: 'setup' | 'bidding' | 'speaking' | 'ended';
  step: number;
  epoch: number;
  max_epochs: number;
  quota_per_epoch: number;
  cold_start: boolean;
  agents: Record<string, AgentState>;
  current_bids: NullableAgentScoreMap;
  pending_bidders: string[];
  current_speaker: string | null;
  speaker_type: 'quota' | 'fallback' | 'cold_start' | null;
  epoch_summary_written: number | null;
  team_name: string;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  last_speech_step: number;
  hold_count: number;
  bid_release_step: number;
  end_reason_content: string | null;
  transcript: TranscriptEntry[];
  transcript_rendered: number;
  bid_threshold: number;
};

// ─── Result<T> for pure functions ─────────────────────────────────────────────

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; detail?: Record<string, unknown> };

// ─── ResolveResult ────────────────────────────────────────────────────────────

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
  | { winner: string; step?: never; speaker_type: 'quota' | 'fallback' | 'cold_start' }
  | { no_winner: true; reason: ResolveReason };

// ─── Discriminated return payloads used by handlers ────────────────────────

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
  }[];
};

export type StepPhase =
  | { status: 'setup'; phase: 'not_ready' }
  | { status: 'bidding'; phase: 'bidding'; pending_bidders: string[]; hold_count: number }
  | { status: 'bidding'; phase: 'resolved'; winner: string }
  | { status: 'bidding'; phase: 'epoch_transition'; epoch: number }
  | { status: 'bidding'; phase: 'ended'; reason: EndReason }
  | { status: 'bidding'; phase: 'expelled'; agents: string[]; hint: string }
  | { status: 'speaking'; phase: 'speech_done'; speaker: string; content: string }
  | { status: 'speaking'; phase: 'speech_pending'; elapsed: number }
  | { status: 'speaking'; phase: 'speech_timeout'; speaker: string }
  | { status: 'ended'; phase: 'ended'; reason: EndReason };

export type PersonaSeedInput = {
  controversy_axes: ControversyAxis[];
  n: number;
  seed: number | null;
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

export type PersonaAssignment = {
  positions: Record<string, string>;
  tone: ToneAssignment;
  persona_seed: number;
  shared_position_with?: number;
};
