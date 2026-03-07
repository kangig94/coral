#!/usr/bin/env node

/**
 * SessionStart hook — cleans up stale flag files (>6h) from .claude/coral/tmp/.
 * Handles memo-reminded-{session}, kb-active-{session}, and ralph-state-{session}.json prefixes.
 * Fail-open: any error exits silently.
 */

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const STALE_PREFIXES = ['memo-reminded-', 'kb-active-', 'ralph-state-'];
const STALE_MS = 6 * 60 * 60_000;

try {
  const flagDir = join(process.env.CLAUDE_PROJECT_DIR || '.', '.claude', 'coral', 'tmp');
  if (!existsSync(flagDir)) process.exit(0);

  const now = Date.now();
  for (const f of readdirSync(flagDir)) {
    if (!STALE_PREFIXES.some(p => f.startsWith(p))) continue;
    const path = join(flagDir, f);
    if (now - statSync(path).mtimeMs > STALE_MS) unlinkSync(path);
  }
} catch {
  process.exit(0);
}
