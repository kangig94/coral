#!/usr/bin/env node

/**
 * PreToolUse hook — reminds Claude to write memos for non-obvious discoveries.
 * Throttled: once per 15 minutes per session via flag file mtime check.
 * Fail-open: any error exits silently.
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const THROTTLE_MIN = 15;
const STALE_MS = 24 * 60 * 60_000;
const FLAG_PREFIX = 'memo-reminded-';

try {
  const input = JSON.parse(await readStdin());
  const sessionId = input.session_id;
  if (!sessionId) process.exit(0);

  const flagDir = join(process.env.CLAUDE_PROJECT_DIR || '.', '.claude', 'coral', 'tmp');
  const flag = join(flagDir, `${FLAG_PREFIX}${sessionId}`);

  if (existsSync(flag)) {
    const ageMin = (Date.now() - statSync(flag).mtimeMs) / 60_000;
    if (ageMin < THROTTLE_MIN) process.exit(0);
  }

  mkdirSync(flagDir, { recursive: true });
  writeFileSync(flag, '');

  // Clean up stale flag files from expired sessions
  try {
    const now = Date.now();
    for (const f of readdirSync(flagDir)) {
      if (!f.startsWith(FLAG_PREFIX) || f === `${FLAG_PREFIX}${sessionId}`) continue;
      const path = join(flagDir, f);
      if (now - statSync(path).mtimeMs > STALE_MS) unlinkSync(path);
    }
  } catch { /* fail-open */ }

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: 'Memo reminder: When you discover something non-obvious during this task (painful root cause, unexpected gotcha, clever solution), write immediately to .claude/coral/memo/<timestamp>-<topic>.md. Keep brief - one paragraph + context.',
    },
  }));
} catch {
  process.exit(0);
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve('{}'));
  });
}
