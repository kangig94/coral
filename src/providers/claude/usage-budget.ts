import { join } from 'node:path';

import type { ProviderCurationUsageRuntime } from '../contract.js';

const USAGE_CACHE_STALE_MS = 10 * 60 * 1000;
const USAGE_5H_THRESHOLD = 50;
const USAGE_WK_THRESHOLD = 70;

export function isClaudeCurationUsageBudgetExhausted(options: {
  readonly configDir: string;
  readonly runtime: ProviderCurationUsageRuntime;
}): boolean {
  try {
    const cachePath = join(options.configDir, 'hud', '.coral-cache.json');
    const raw = JSON.parse(options.runtime.storage.readFileSync(cachePath, 'utf-8')) as Record<string, unknown>;
    const entry = raw.claude as
      | { ts?: number; data?: { fiveHour?: number; weekly?: number }; error?: boolean }
      | undefined;
    if (!entry?.ts || !entry.data || entry.error) return false;
    if (options.runtime.now() - entry.ts > USAGE_CACHE_STALE_MS) return false;

    const { fiveHour, weekly } = entry.data;
    return (
      (typeof fiveHour === 'number' && fiveHour >= USAGE_5H_THRESHOLD) ||
      (typeof weekly === 'number' && weekly >= USAGE_WK_THRESHOLD)
    );
  } catch {
    return false;
  }
}
