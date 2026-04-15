import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE_CACHE_STALE_MS = 10 * 60 * 1000;
const USAGE_5H_THRESHOLD = 90;
const USAGE_WK_THRESHOLD = 100;

export function isUsageBudgetExhausted(): boolean {
  try {
    const cachePath = join(homedir(), '.claude', 'hud', '.coral-cache.json');
    const raw = JSON.parse(readFileSync(cachePath, 'utf-8')) as Record<string, unknown>;
    const entry = raw.claude as
      | { ts?: number; data?: { fiveHour?: number; weekly?: number }; error?: boolean }
      | undefined;
    if (!entry?.ts || !entry.data || entry.error) {
      return false;
    }
    if (Date.now() - entry.ts > USAGE_CACHE_STALE_MS) {
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
