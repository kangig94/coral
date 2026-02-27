#!/usr/bin/env node

/**
 * UserPromptSubmit + Stop hook — tracks plan mode state via flag files.
 * UserPromptSubmit: /coral:plan or /plan → create flag.
 * Stop: delete flag (planning turn ended).
 * Fail-open: any error exits silently.
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const PLAN_START = /^\/(coral:)?plan(\s|$)/i;
const FLAG_PREFIX = 'plan-active-';
const STALE_MS = 24 * 60 * 60_000;

try {
  const input = JSON.parse(await readStdin());
  const event = input.hook_event_name;
  const sessionId = input.session_id;
  if (!sessionId) process.exit(0);

  const flagDir = join(process.env.CLAUDE_PROJECT_DIR || '.', '.claude', 'coral', 'tmp');
  const flag = join(flagDir, `${FLAG_PREFIX}${sessionId}`);

  if (event === 'UserPromptSubmit') {
    const prompt = (input.prompt || '').trim();
    if (PLAN_START.test(prompt)) {
      mkdirSync(flagDir, { recursive: true });
      writeFileSync(flag, new Date().toISOString());
    }
  } else if (event === 'Stop') {
    if (existsSync(flag)) unlinkSync(flag);
  }

  // Clean up stale flags from expired sessions
  try {
    const now = Date.now();
    for (const f of readdirSync(flagDir)) {
      if (!f.startsWith(FLAG_PREFIX) || f === `${FLAG_PREFIX}${sessionId}`) continue;
      const path = join(flagDir, f);
      if (now - statSync(path).mtimeMs > STALE_MS) unlinkSync(path);
    }
  } catch { /* fail-open */ }
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
