/**
 * Discuss wait module - async state polling.
 */

import * as fs from 'node:fs';
import type { DiscussState } from './types.js';

/** Infinite polling sentinel for bid holds. */
export const INFINITE_POLL = 0;

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
  intervalMs = 500,
): Promise<WaitResult> {
  const startAt = Date.now();
  const infinite = timeoutMs <= 0;

  const initial = await tryReadState(statePath);
  if (initial && predicate(initial)) {
    return { fulfilled: true, elapsed_ms: 0, state: initial, error: null };
  }

  let lastKnownGood: DiscussState | null = initial;

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const done = (result: WaitResult) => {
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const check = async () => {
      const state = await tryReadState(statePath);
      if (state) lastKnownGood = state;

      if (state && predicate(state)) {
        done({ fulfilled: true, elapsed_ms: Date.now() - startAt, state, error: null });
        return;
      }

      if (!infinite && Date.now() - startAt >= timeoutMs) {
        const elapsedMs = Date.now() - startAt;
        if (lastKnownGood) {
          done({ fulfilled: false, elapsed_ms: elapsedMs, state: lastKnownGood, error: null });
        } else {
          done({ fulfilled: false, elapsed_ms: elapsedMs, state: null, error: 'state_unavailable' });
        }
        return;
      }

      timer = setTimeout(check, intervalMs);
    };

    timer = setTimeout(check, intervalMs);
  });
}

/** Safe async read - returns null if file is mid-rename/corrupt. */
async function tryReadState(p: string): Promise<DiscussState | null> {
  try {
    return JSON.parse(await fs.promises.readFile(p, 'utf8')) as DiscussState;
  } catch {
    return null;
  }
}
