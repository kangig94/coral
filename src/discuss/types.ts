/**
 * Shared types for the discuss MCP server.
 * Pure data — zero imports from node: or project modules.
 */

// ─── Transcript entries (discriminated union) ────────────────────────────────

export type TranscriptEntry =
  | { type: 'bids'; step: number; epoch: number; ts: string;
      bids: Record<string, number>; winner: string | null;
      resolve_type: 'normal' | 'fallback' | 'cold_start' | 'no_winner'; }
  | { type: 'speech'; step: number; epoch: number; ts: string;
      agent: string; display_name: string; content: string; }
  | { type: 'epoch_summary'; epoch: number; ts: string; summary: string; }
  | { type: 'session_event'; epoch: number; ts: string;
      event: 'force_end' | 'synthesis'; detail: string; };

// ─── AgentState ───────────────────────────────────────────────────────────────

export interface AgentState {
  persona: string;
  display_name: string;       // parsed from persona first line `# Name — Role`
  quota_remaining: number;
  total_speaks: number;
  fallback_used: boolean;
}

// ─── DiscussState ─────────────────────────────────────────────────────────────

export interface DiscussState {
  session_id: string;
  session_dir: string;
  topic: string;
  status: 'setup' | 'bidding' | 'speaking' | 'ended';
  step: number;
  epoch: number;
  max_epochs: number;
  quota_per_epoch: number;
  cold_start: boolean;
  recent_turns: number;
  agents: Record<string, AgentState>;
  current_bids: Record<string, number | null>;
  pending_bidders: string[];
  current_speaker: string | null;
  speaker_type: 'normal' | 'fallback' | 'cold_start' | null;
  epoch_summary_written: number | null;
  team_name: string;
  created_at: string;
  updated_at: string;
  last_activity_at: string;        // updated on all state mutations, used for TTL cleanup
  last_speech_step: number;        // monotonic marker: set to step when speech recorded
  transcript: TranscriptEntry[];   // structured transcript in state
  transcript_rendered: number;     // tracks .md append position
  bid_threshold: number;           // minimum bid score to win the floor (default 50)
  transcript_read_step: Record<string, number>; // last step when agent called discuss_transcript (bid enforcement)
}

// ─── Result<T> for pure functions ─────────────────────────────────────────────

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; detail?: Record<string, unknown> };

// ─── ResolveResult ────────────────────────────────────────────────────────────

/**
 * Sealed-bid design: individual bid scores are never returned to any caller.
 * The audit trail (all_bids) lives in state.json transcript entries only.
 */
export type ResolveResult =
  | { winner: string; step: number; resolve_type: 'normal' | 'fallback' | 'cold_start' }
  | { no_winner: true; step: number; reason: string; new_epoch?: boolean; epoch?: number };

// ─── WaitCondition ────────────────────────────────────────────────────────────

export type WaitCondition = 'all_bids' | 'speech_delivered' | 'action_needed';
