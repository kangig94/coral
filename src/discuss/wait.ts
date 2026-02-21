/**
 * Discuss wait module — blocking condition-based file watcher.
 * Polls state.json at intervals until predicate is true or timeout expires.
 * Uses clearTimeout on resolution to prevent orphaned timer chains.
 */

import * as fs from 'node:fs';
import type { DiscussState } from './types.js';

/** Result of waitForCondition. Discriminated on `error`: when set, no valid state was ever read. */
export type WaitResult =
  | { fulfilled: boolean; elapsed_ms: number; state: DiscussState; error: null }
  | { fulfilled: false; elapsed_ms: number; state: null; error: string };

/**
 * Poll state.json until predicate returns true or timeoutMs expires.
 *
 * Cancellation safety: stores setTimeout handle and clears it on resolution,
 * preventing orphaned timer chains if the MCP client disconnects.
 *
 * lastKnownGood pattern: tracks last successful read so timeout always returns
 * a valid state rather than crashing on null dereference.
 */
export async function waitForCondition(
  statePath: string,
  predicate: (s: DiscussState) => boolean,
  timeoutMs: number,
  intervalMs = 500,
): Promise<WaitResult> {
  const start = Date.now();

  // Immediate first check before entering poll loop
  const initial = await tryReadState(statePath);
  if (initial && predicate(initial)) {
    return { fulfilled: true, elapsed_ms: 0, state: initial, error: null };
  }

  let lastKnownGood: DiscussState | null = initial;

  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const done = (result: WaitResult) => {
      if (timer) clearTimeout(timer); // prevent orphaned timers
      resolve(result);
    };

    const check = async () => {
      const state = await tryReadState(statePath);
      if (state) lastKnownGood = state;

      if (state && predicate(state)) {
        done({ fulfilled: true, elapsed_ms: Date.now() - start, state, error: null });
        return;
      }

      if (Date.now() - start >= timeoutMs) {
        if (lastKnownGood) {
          done({ fulfilled: false, elapsed_ms: Date.now() - start, state: lastKnownGood, error: null });
        } else {
          done({ fulfilled: false, elapsed_ms: Date.now() - start, state: null, error: 'state_unavailable' });
        }
        return;
      }

      timer = setTimeout(check, intervalMs);
    };

    timer = setTimeout(check, intervalMs);
  });
}

/** Safe async read — returns null if file is mid-rename, missing, or corrupt JSON. */
async function tryReadState(p: string): Promise<DiscussState | null> {
  try {
    return JSON.parse(await fs.promises.readFile(p, 'utf8')) as DiscussState;
  } catch {
    return null;
  }
}
