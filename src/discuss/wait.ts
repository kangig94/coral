import * as fs from 'node:fs';
import type { DiscussState } from './types.js';

export const INFINITE_POLL = 0;

let _defaultPollMs = 500;
export function _setDefaultPollMs(ms: number): void { _defaultPollMs = ms; }
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type WaitResult =
  | { fulfilled: boolean; elapsed_ms: number; state: DiscussState; error: null }
  | { fulfilled: false; elapsed_ms: number; state: null; error: string };

export async function waitForCondition(
  statePath: string,
  predicate: (s: DiscussState) => boolean,
  timeoutMs: number,
  intervalMs = _defaultPollMs,
): Promise<WaitResult> {
  const startAt = Date.now();
  const deadline = timeoutMs > 0 ? startAt + timeoutMs : Number.POSITIVE_INFINITY;

  const initial = await readState(statePath);
  if (initial && predicate(initial)) {
    return { fulfilled: true, elapsed_ms: 0, state: initial, error: null };
  }

  let lastKnownGood: DiscussState | null = initial;
  while (true) {
    const now = Date.now();
    const elapsedMs = now - startAt;
    if (now >= deadline) {
      if (lastKnownGood) {
        return { fulfilled: false, elapsed_ms: elapsedMs, state: lastKnownGood, error: null };
      }
      return { fulfilled: false, elapsed_ms: elapsedMs, state: null, error: 'state_unavailable' };
    }

    await sleep(intervalMs);
    const state = await readState(statePath);
    if (!state) continue;
    lastKnownGood = state;
    if (predicate(state)) {
      return { fulfilled: true, elapsed_ms: Date.now() - startAt, state, error: null };
    }
  }
}

export const allBidsIn = (state: DiscussState): boolean =>
  state.status === 'bidding' && state.pending_bidders.length === 0;

export const speechDelivered = (state: DiscussState): boolean =>
  state.status === 'bidding' && state.last_speech_step === state.step - 1;

export const bidReleased = (agentName: string, bidStep: number) =>
  (state: DiscussState): boolean => {
    if (state.status === 'ended') return true;
    if (state.agents[agentName]?.banned === true) return true;
    return state.bid_release_step >= bidStep;
  };

export const isWinner = (agentName: string) =>
  ({ status, current_speaker }: DiscussState): boolean =>
    status === 'speaking' && current_speaker === agentName;

export const setupComplete = (state: DiscussState): boolean => state.status !== 'setup';

export const noEligibleParticipants = (state: DiscussState): boolean =>
  Object.values(state.agents).every((agent) =>
    agent.participation !== 'required'
    || agent.banned
    || (agent.quota_remaining === 0 && agent.fallback_used),
  );

async function readState(statePath: string): Promise<DiscussState | null> {
  try {
    return JSON.parse(await fs.promises.readFile(statePath, 'utf8')) as DiscussState;
  } catch {
    return null;
  }
}
