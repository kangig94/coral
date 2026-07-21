type AgentScoreMap = Record<string, number>;
type NullableAgentScoreMap = Record<string, number | null>;

export const speakerTypes = ['quota', 'fallback', 'cold_start', 'forced'] as const;
type SpeakerType = (typeof speakerTypes)[number];

export const transcriptResolveTypes = ['normal', 'fallback', 'cold_start', 'forced', 'no_winner'] as const;
export type TranscriptResolveType = (typeof transcriptResolveTypes)[number];

export const participationTypes = ['required', 'observer'] as const;
type ParticipationType = (typeof participationTypes)[number];

export const discussStatuses = ['setup', 'bidding', 'speaking', 'ended'] as const;
type DiscussStatus = (typeof discussStatuses)[number];

export const resolveReasons = ['all_below_threshold', 'max_epochs_reached', 'all_blocked', 'epoch_transition'] as const;

export const endReasons = ['all_below_threshold', 'max_epochs_reached', 'all_blocked', 'no_participants'] as const;

export const sessionEventKinds = ['force_end', 'synthesis'] as const;
type SessionEventKind = (typeof sessionEventKinds)[number];

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
  | ({ type: 'speech'; agent: string; display_name: string; content: string } & TranscriptStepMetadata)
  | ({ type: 'follow_up'; agent: string; question: string; answer: string } & TranscriptEpochMetadata)
  | ({ type: 'epoch_summary'; summary: string } & TranscriptEpochMetadata)
  | ({ type: 'session_event'; event: SessionEventKind; detail: string } & TranscriptEpochMetadata);

export type AgentState = {
  persona: string;
  display_name: string;
  participation: ParticipationType;
  quota_remaining: number;
  total_speaks: number;
  fallback_used: boolean;
  banned: boolean;
};

export type DiscussState = {
  session_id: string;
  topic: string;
  status: DiscussStatus;
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
  bid_release_step: number;
  end_reason_content: string | null;
  transcript: TranscriptEntry[];
  bid_threshold: number;
  min_bid_delay_ms: number;
};

const transcriptMetadataSchema = {
  step: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
  ts: z.string(),
};

const transcriptEntrySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('bids'),
      ...transcriptMetadataSchema,
      bids: z.record(z.number()),
      effective_bids: z.record(z.number()).optional(),
      thoughts: z.record(z.string()).optional(),
      winner: z.string().nullable(),
      resolve_type: z.enum(transcriptResolveTypes),
    })
    .strict(),
  z
    .object({
      type: z.literal('speech'),
      ...transcriptMetadataSchema,
      agent: z.string(),
      display_name: z.string(),
      content: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('follow_up'),
      agent: z.string(),
      question: z.string(),
      answer: z.string(),
      epoch: z.number().int().nonnegative(),
      ts: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('epoch_summary'),
      summary: z.string(),
      epoch: z.number().int().nonnegative(),
      ts: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('session_event'),
      event: z.enum(sessionEventKinds),
      detail: z.string(),
      epoch: z.number().int().nonnegative(),
      ts: z.string(),
    })
    .strict(),
]);

const agentStateSchema = z
  .object({
    persona: z.string(),
    display_name: z.string(),
    participation: z.enum(participationTypes),
    quota_remaining: z.number(),
    total_speaks: z.number(),
    fallback_used: z.boolean(),
    banned: z.boolean(),
  })
  .strict();

export const discussStateSchema: z.ZodType<DiscussState> = z
  .object({
    session_id: z.string(),
    topic: z.string(),
    status: z.enum(discussStatuses),
    step: z.number().int().nonnegative(),
    epoch: z.number().int().nonnegative(),
    max_epochs: z.number().int().positive(),
    quota_per_epoch: z.number().int().positive(),
    cold_start: z.boolean(),
    agents: z.record(agentStateSchema),
    current_bids: z.record(z.number().nullable()),
    current_thoughts: z.record(z.string()),
    pending_bidders: z.array(z.string()),
    current_speaker: z.string().nullable(),
    speaker_type: z.enum(speakerTypes).nullable(),
    epoch_summary_written: z.number().int().nullable(),
    created_at: z.string(),
    last_activity_at: z.string(),
    last_speech_step: z.number().int().nonnegative(),
    bid_release_step: z.number().int().nonnegative(),
    end_reason_content: z.string().nullable(),
    transcript: z.array(transcriptEntrySchema),
    bid_threshold: z.number(),
    min_bid_delay_ms: z.number().int().nonnegative(),
  })
  .strict();

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; detail?: Record<string, unknown> };

type ResolveReason = (typeof resolveReasons)[number];

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

export type SpeechResult =
  | { action: 'speech_recorded' }
  | { action: 'not_your_turn'; current_speaker: string | null }
  | { action: 'session_ended'; reason?: string; content?: string };

export type EndReason = (typeof endReasons)[number];

export type DiscussCreateInput = {
  topic: string;
  agents: {
    name: string;
    persona: string;
    participation: ParticipationType;
  }[];
  min_bid_delay_ms: number;
};

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
import { z } from 'zod';
