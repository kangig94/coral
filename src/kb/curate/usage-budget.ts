import { join } from 'node:path';
import type { StoragePort } from '../../infra/port-types.js';

const USAGE_CACHE_STALE_MS = 10 * 60 * 1000;
const USAGE_5H_THRESHOLD = 50;
const USAGE_WK_THRESHOLD = 70;

type UsageBudgetStorage = Pick<StoragePort, 'readFileSync'>;

export type UsageBudgetOptions = {
  storage: UsageBudgetStorage;
  claudeConfigDir?: string;
  now: () => number;
};

export function isUsageBudgetExhausted({ storage, claudeConfigDir, now }: UsageBudgetOptions): boolean {
  if (claudeConfigDir === undefined) {
    return false;
  }

  try {
    const cachePath = join(claudeConfigDir, 'hud', '.coral-cache.json');
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
