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

export type { DiscussDetailResponse, DiscussSummaryDto, DiscussView } from './views.js';
export type { DiscussContext } from './shell/context.js';
export type { RecoveredDiscussResume } from './shell/operations.js';
export { DiscussSessionStore } from './shell/session-store.js';
