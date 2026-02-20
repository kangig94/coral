/**
 * Discuss wait module — blocking condition-based file watcher.
 * Polls state.json at intervals until predicate is true or timeout expires.
 * Uses clearTimeout on resolution to prevent orphaned timer chains.
 */

import * as fs from 'node:fs';
import { normalizeState } from './session-store.js';
import type { DiscussState } from './types.js';

/** Result of waitForCondition. error field is set only when no valid state was ever read. */
export type WaitResult = {
  fulfilled: boolean;
  elapsed_ms: number;
  state: DiscussState;
  error?: string;
};

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
    return { fulfilled: true, elapsed_ms: 0, state: initial };
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
        done({ fulfilled: true, elapsed_ms: Date.now() - start, state });
        return;
      }

      if (Date.now() - start >= timeoutMs) {
        if (lastKnownGood) {
          done({ fulfilled: false, elapsed_ms: Date.now() - start, state: lastKnownGood });
        } else {
          // No valid state ever read — explicit error (not a runtime crash)
          done({ fulfilled: false, elapsed_ms: Date.now() - start, state: null as unknown as DiscussState, error: 'state_unavailable' });
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
    const raw = await fs.promises.readFile(p, 'utf8');
    return normalizeState(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return null;
  }
}
