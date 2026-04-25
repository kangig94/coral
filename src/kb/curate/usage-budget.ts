import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeStoragePort } from '../../runtime/ports.js';

const USAGE_CACHE_STALE_MS = 10 * 60 * 1000;
const USAGE_5H_THRESHOLD = 90;
const USAGE_WK_THRESHOLD = 100;

export type UsageBudgetStorage = Pick<RuntimeStoragePort, 'readFileSync'>;

export type UsageBudgetOptions = {
  homeDir?: string;
  now?: () => number;
  storage?: UsageBudgetStorage;
};

const nodeStorage: UsageBudgetStorage = { readFileSync };

export function isUsageBudgetExhausted({
  homeDir,
  now = Date.now,
  storage = nodeStorage,
}: UsageBudgetOptions = {}): boolean {
  if (homeDir === undefined) {
    return false;
  }

  try {
    const cachePath = join(homeDir, '.claude', 'hud', '.coral-cache.json');
    const raw = JSON.parse(storage.readFileSync(cachePath, 'utf-8')) as Record<string, unknown>;
    const entry = raw.claude as
      | { ts?: number; data?: { fiveHour?: number; weekly?: number }; error?: boolean }
      | undefined;
    if (!entry?.ts || !entry.data || entry.error) {
      return false;
    }
    if (now() - entry.ts > USAGE_CACHE_STALE_MS) {
      return false;
    }
    const { fiveHour, weekly } = entry.data;
    if (typeof fiveHour === 'number' && fiveHour >= USAGE_5H_THRESHOLD) {
      return true;
    }
    if (typeof weekly === 'number' && weekly >= USAGE_WK_THRESHOLD) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
