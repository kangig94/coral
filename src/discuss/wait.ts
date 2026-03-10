import { promises as fsPromises, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { DiscussState } from './types.js';
import { sleep } from './util/time.js';

type ReadResult = { state: DiscussState | null; mtimeMs: number };

export const INFINITE_POLL = 0;
const MAX_READ_ERRORS = Number(process.env.CORAL_DISCUSS_MAX_READ_ERRORS) || 3;

let _defaultPollMs = 500;
export function _setDefaultPollMs(ms: number): void { _defaultPollMs = ms; }

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
  let lastKnownGood: DiscussState | null = null;
  let consecutiveReadErrors = 0;
  let lastCorruptMtimeMs = 0;
  const dir = dirname(statePath);
  const file = basename(statePath);
  let watcher: FSWatcher | null = null;
  let notify: (() => void) | null = null;
  const onStateRead = ({ state, mtimeMs }: ReadResult, elapsedMs: number, polling = false): WaitResult | null => {
    if (!state) {
      // In polling mode (no watcher), guard against repeated reads of the same corrupt
      // file — e.g. when inotify is unavailable (ENOSPC), the same version gets polled
      // every intervalMs and must not inflate the error count.
      if (!polling || mtimeMs !== lastCorruptMtimeMs) {
        consecutiveReadErrors += 1;
        lastCorruptMtimeMs = mtimeMs;
      }
      if (consecutiveReadErrors >= MAX_READ_ERRORS) {
        return { fulfilled: false, elapsed_ms: elapsedMs, state: null, error: 'state_corrupt' };
      }
      return null;
    }

    consecutiveReadErrors = 0;
    lastCorruptMtimeMs = 0;
    lastKnownGood = state;
    if (predicate(state)) {
      return { fulfilled: true, elapsed_ms: elapsedMs, state, error: null };
    }
    return null;
  };

  const initial = await readState(statePath);
  const initialResult = onStateRead(initial, 0);
  if (initialResult) return initialResult;

  try {
    const activeWatcher = watch(dir, (_eventType, filename) => {
      const changedFile = typeof filename === 'string' ? filename : null;
      if (changedFile !== file) return;
      // Clear notify before calling to prevent duplicate fires from rapid event bursts.
      // If multiple inotify events fire for the same rename, only the first
      // triggers a read; subsequent events see notify=null and are no-ops.
      const n = notify;
      notify = null;
      n?.();
    });
    activeWatcher.on('error', () => {
      activeWatcher.close();
      if (watcher === activeWatcher) watcher = null;
    });
    watcher = activeWatcher;
  } catch {
    watcher = null;
  }

  const postWatch = await readState(statePath);
  const postWatchResult = onStateRead(postWatch, Date.now() - startAt);
  if (postWatchResult) {
    watcher?.close();
    return postWatchResult;
  }

  try {
    while (true) {
      const now = Date.now();
      const elapsedMs = now - startAt;
      if (now >= deadline) {
        if (lastKnownGood) {
          return { fulfilled: false, elapsed_ms: elapsedMs, state: lastKnownGood, error: null };
        }
        return { fulfilled: false, elapsed_ms: elapsedMs, state: null, error: 'state_unavailable' };
      }

      const remainingMs = Math.min(deadline - now, watcher ? 5000 : intervalMs);

      if (watcher) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remainingMs);
          notify = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        notify = null;
      } else {
        await sleep(Math.min(intervalMs, remainingMs));
      }

      const read = await readState(statePath);
      const stateResult = onStateRead(read, Date.now() - startAt, !watcher);
      if (stateResult) return stateResult;
    }
  } finally {
    watcher?.close();
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

async function readState(statePath: string): Promise<ReadResult> {
  let mtimeMs = 0;
  try {
    const [content, stat] = await Promise.all([
      fsPromises.readFile(statePath, 'utf8'),
      fsPromises.stat(statePath),
    ]);
    mtimeMs = stat.mtimeMs;
    return { state: JSON.parse(content) as DiscussState, mtimeMs };
  } catch {
    return { state: null, mtimeMs };
  }
}
