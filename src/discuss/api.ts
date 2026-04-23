import { z } from 'zod';
import {
  getWatchState,
  startDiscussSession,
  submitManualBid,
  submitManualSpeech,
} from './shell/operations.js';
import { runFollowUpTurns } from './shell/followup-flow.js';
import { handleSynthesis } from './shell/synthesis-flow.js';
import { loadDiscussDetail, listDiscussSessions } from './shell/read-helpers.js';
import { loadAttachedOrPersistedSnapshot } from './shell/persistence.js';
import { runStartup } from './reconcile.js';
import { buildAuditView, buildControlView } from './projections.js';
import type { PersistedDiscussSnapshot } from './events.js';
import type { DiscussState } from './session-types.js';
import {
  discussBidSchema,
  discussSpeechSchema,
  discussStartSchema,
} from './command-schemas.js';
import type {
  DiscussAuditTranscriptEntryDto,
  DiscussControlTranscriptEntryDto,
} from './view-types.js';

const projectRootSchema = z.string().min(1, 'Project root is required');
const sessionIdSchema = z.string().min(1, 'Session ID is required');

export const discussDetailQuerySchema = z
  .object({
    projectRoot: projectRootSchema,
    view: z.enum(['control', 'audit']).optional(),
  })
  .strict();

export const discussEventsQuerySchema = z
  .object({
    cursor: z.coerce.number().int().min(0).optional(),
    projectRoot: projectRootSchema,
  })
  .strict();

export const discussDeleteQuerySchema = z
  .object({
    projectRoot: projectRootSchema,
  })
  .strict();

export const discussSessionListRequestSchema = z.object({}).strict();

export const discussSessionCreateRequestSchema = discussStartSchema
  .extend({
    projectRoot: projectRootSchema,
    owner: z.string().optional(),
    effort: z.string().optional(),
    claudeModelCap: z.string().optional(),
  })
  .strict();

export const discussSessionDetailRequestSchema = discussDetailQuerySchema.extend({
  sessionId: sessionIdSchema,
});

export const discussSessionEventsRequestSchema = discussEventsQuerySchema.extend({
  sessionId: sessionIdSchema,
});

export const discussSessionDeleteRequestSchema = discussDeleteQuerySchema.extend({
  sessionId: sessionIdSchema,
});

export const discussSessionBidRequestSchema = discussBidSchema
  .omit({ session: true })
  .extend({
    sessionId: sessionIdSchema,
    projectRoot: projectRootSchema,
    owner: z.string().optional(),
    effort: z.string().optional(),
    claudeModelCap: z.string().optional(),
  })
  .strict();

export const discussSessionSpeechRequestSchema = discussSpeechSchema
  .omit({ session: true })
  .extend({
    sessionId: sessionIdSchema,
    projectRoot: projectRootSchema,
    owner: z.string().optional(),
    effort: z.string().optional(),
    claudeModelCap: z.string().optional(),
  })
  .strict();

export const discussCommands = {
  start: startDiscussSession,
  watch: getWatchState,
  bid: submitManualBid,
  speech: submitManualSpeech,
  followup: runFollowUpTurns,
  synthesis: handleSynthesis,
};

export const discussQueries = {
  get: loadDiscussDetail,
  list: listDiscussSessions,
  snapshot: loadAttachedOrPersistedSnapshot,
};

export const discussReconcile = { runStartup };

export type DiscussAuthority = 'live' | 'persisted';
export type DiscussView = 'control' | 'audit';

type DiscussAgentDto = {
  name: string;
  displayName: string;
  participation: 'required' | 'observer';
  totalSpeaks: number;
  banned: boolean;
};

type DiscussSessionDto = {
  sessionId: string;
  projectRoot: string;
  topic: string;
  status: DiscussState['status'];
  step: number;
  epoch: number;
  maxEpochs: number;
  quotaPerEpoch: number;
  coldStart: boolean;
  currentSpeaker: string | null;
  speakerType: DiscussState['speaker_type'];
  epochSummaryWritten: number | null;
  createdAt: string;
  lastActivityAt: string;
  lastSpeechStep: number;
  bidReleaseStep: number;
  endReasonContent: string | null;
  bidThreshold: number;
  minBidDelayMs: number;
  agents: DiscussAgentDto[];
};

export type DiscussControlSessionDto = DiscussSessionDto;
export type DiscussAuditSessionDto = DiscussSessionDto;

export type DiscussSummaryDto = {
  sessionId: string;
  projectRoot: string;
  topic: string;
  status: DiscussState['status'];
  createdAt: string;
  agentCount: number;
  authority: DiscussAuthority;
};

export type DiscussControlDetailResponse = {
  authority: DiscussAuthority;
  view: 'control';
  session: DiscussControlSessionDto;
  transcript: DiscussControlTranscriptEntryDto[];
  lastSeq: number;
};

export type DiscussAuditDetailResponse = {
  authority: DiscussAuthority;
  view: 'audit';
  session: DiscussAuditSessionDto;
  transcript: DiscussAuditTranscriptEntryDto[];
  lastSeq: number;
};

export type DiscussDetailResponse = DiscussControlDetailResponse | DiscussAuditDetailResponse;

function buildDiscussAgents(state: DiscussState): DiscussAgentDto[] {
  return Object.entries(state.agents).map(([name, agent]) => ({
    name,
    displayName: agent.display_name,
    participation: agent.participation,
    totalSpeaks: agent.total_speaks,
    banned: agent.banned,
  }));
}

function buildDiscussSession(snapshot: PersistedDiscussSnapshot): DiscussSessionDto {
  const { state } = snapshot;
  return {
    sessionId: state.session_id,
    projectRoot: snapshot.projectRoot,
    topic: state.topic,
    status: state.status,
    step: state.step,
    epoch: state.epoch,
    maxEpochs: state.max_epochs,
    quotaPerEpoch: state.quota_per_epoch,
    coldStart: state.cold_start,
    currentSpeaker: state.current_speaker,
    speakerType: state.speaker_type,
    epochSummaryWritten: state.epoch_summary_written,
    createdAt: state.created_at,
    lastActivityAt: state.last_activity_at,
    lastSpeechStep: state.last_speech_step,
    bidReleaseStep: state.bid_release_step,
    endReasonContent: state.end_reason_content,
    bidThreshold: state.bid_threshold,
    minBidDelayMs: state.min_bid_delay_ms,
    agents: buildDiscussAgents(state),
  };
}

export function buildDiscussSummary(
  snapshot: PersistedDiscussSnapshot,
  authority: DiscussAuthority,
): DiscussSummaryDto {
  return {
    sessionId: snapshot.sessionId,
    projectRoot: snapshot.projectRoot,
    topic: snapshot.state.topic,
    status: snapshot.state.status,
    createdAt: snapshot.state.created_at,
    agentCount: Object.keys(snapshot.state.agents).length,
    authority,
  };
}

export function buildDiscussDetail(
  snapshot: PersistedDiscussSnapshot,
  view: 'control',
  authority: DiscussAuthority,
): DiscussControlDetailResponse;
export function buildDiscussDetail(
  snapshot: PersistedDiscussSnapshot,
  view: 'audit',
  authority: DiscussAuthority,
): DiscussAuditDetailResponse;
export function buildDiscussDetail(
  snapshot: PersistedDiscussSnapshot,
  view: DiscussView,
  authority: DiscussAuthority,
): DiscussDetailResponse {
  const session = buildDiscussSession(snapshot);
  if (view === 'audit') {
    const { transcript, lastSeq } = buildAuditView(snapshot);
    return {
      authority,
      view,
      session,
      transcript,
      lastSeq,
    };
  }

  const { transcript, lastSeq } = buildControlView(snapshot);
  return {
    authority,
    view,
    session,
    transcript,
    lastSeq,
  };
}

export {
  discussBidSchema,
  discussSeedSchema,
  discussSpeechSchema,
  discussStartSchema,
} from './command-schemas.js';
export type {
  DiscussBidInput,
  DiscussSeedInput,
  DiscussSpeechInput,
  DiscussStartInput,
} from './command-schemas.js';
export type { BidResult, PersonaSeedOutput, SpeechResult } from './session-types.js';
export type { WatchState } from './watch.js';
export type { DiscussContext } from './shell/context.js';
export type { RecoveredDiscussResume } from './shell/operations.js';
export { DiscussSessionStore } from './shell/session-store.js';
