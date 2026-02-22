/**
 * Discuss wait module - async state polling.
 */

import * as fs from 'node:fs';
import type { DiscussState } from './types.js';

/** Infinite polling sentinel for bid holds. */
export const INFINITE_POLL = 0;

let _defaultPollMs = 500;
/** Override default poll interval (for tests). */
export function _setDefaultPollMs(ms: number): void { _defaultPollMs = ms; }

/** Result of waitForCondition. */
export type WaitResult =
  | { fulfilled: boolean; elapsed_ms: number; state: DiscussState; error: null }
  | { fulfilled: false; elapsed_ms: number; state: null; error: string };

/**
 * Poll state.json until predicate returns true or timeout expires.
 * When timeoutMs <= 0, polling is infinite.
 */
export async function waitForCondition(
  statePath: string,
  predicate: (s: DiscussState) => boolean,
  timeoutMs: number,
  intervalMs = _defaultPollMs,
): Promise<WaitResult> {
  const startAt = Date.now();
  const infinite = timeoutMs <= 0;

  const initial = await readState(statePath);
  if (initial && predicate(initial)) {
    return { fulfilled: true, elapsed_ms: 0, state: initial, error: null };
  }

  let lastKnownGood: DiscussState | null = initial;
  while (true) {
    const elapsedMs = Date.now() - startAt;
    if (!infinite && elapsedMs >= timeoutMs) {
      return lastKnownGood
        ? { fulfilled: false, elapsed_ms: elapsedMs, state: lastKnownGood, error: null }
        : { fulfilled: false, elapsed_ms: elapsedMs, state: null, error: 'state_unavailable' };
    }

    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
    const state = await readState(statePath);
    if (!state) continue;
    lastKnownGood = state;
    if (predicate(state)) {
      return { fulfilled: true, elapsed_ms: Date.now() - startAt, state, error: null };
    }
  }
}

/** Safe async read - returns null if file is mid-rename/corrupt. */
async function readState(p: string): Promise<DiscussState | null> {
  try {
    return JSON.parse(await fs.promises.readFile(p, 'utf8')) as DiscussState;
  } catch {
    return null;
  }
}
