#!/usr/bin/env node

/**
 * SessionStart hook — cleans up stale flag files (>6h) from .coral/tmp/.
 * Handles memo-reminded-{session}, kb-active-{session}, ralph-state-{session}.json,
 * and active-jobs-{timestamp}-{hex}.json prefixes.
 * Fail-open: any error exits silently.
 */

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const STALE_PREFIXES = ['memo-reminded-', 'kb-active-', 'ralph-state-', 'active-jobs-'];
const STALE_MS = 6 * 60 * 60_000;

try {
  const input = JSON.parse((await readStdin()) || '{}');
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? '.';
  const flagDir = join(projectDir, '.coral', 'tmp');
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

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', chunk => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve('{}'));
  });
}
