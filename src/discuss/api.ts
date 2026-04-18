import {
  getWatchState as watch,
  startDiscussSession as start,
  submitManualBid as bid,
  submitManualSpeech as speech,
} from './shell/operations.js';
import { runFollowUpTurns as followup } from './shell/followup-flow.js';
import { handleSynthesis as synthesis } from './shell/synthesis-flow.js';
import { loadDiscussDetail as get, listDiscussSessions as list } from './shell/read-helpers.js';
import { loadAttachedOrPersistedSnapshot as snapshot } from './shell/persistence.js';
import { runStartup } from './reconcile.js';

export const discussCommands = { start, watch, bid, speech, followup, synthesis };
export const discussQueries = { get, list, snapshot };
export const discussReconcile = { runStartup };
