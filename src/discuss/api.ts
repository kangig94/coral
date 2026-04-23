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
import {
  discussBidSchema,
  discussSpeechSchema,
  discussStartSchema,
} from './command-schemas.js';

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
export {
  buildDiscussDetail,
  buildDiscussSummary,
} from './read-contract.js';
export type {
  DiscussAuthority,
  DiscussDetailResponse,
  DiscussSummaryDto,
  DiscussView,
} from './read-contract.js';

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
