#!/usr/bin/env node

/**
 * Stop/PreCompact hook — enforces KB promotion for unprocessed memos.
 * Stop: skill-scoped via .claude/coral/tmp/kb-active state file.
 * PreCompact: always checks for unprocessed memos.
 * Fail-open: any error exits silently.
 */

import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

try {
  const input = JSON.parse(await readStdin());
  const event = input.hook_event_name;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || '.';
  const stateFile = join(projectDir, '.claude', 'coral', 'tmp', 'kb-active');

  // Stop hook: skill-scoped via state file
  if (event === 'Stop') {
    if (!existsSync(stateFile)) process.exit(0);
    try { unlinkSync(stateFile); } catch { /* ignore */ }
  }

  // Check for unprocessed memos
  const memoDir = join(projectDir, '.claude', 'coral', 'memo');
  if (!existsSync(memoDir)) process.exit(0);

  const memos = readdirSync(memoDir).filter(f => !f.startsWith('.'));
  if (memos.length === 0) process.exit(0);

  const list = memos.join(', ');

  if (event === 'Stop') {
    console.log(JSON.stringify({
      decision: 'block',
      reason: `Unprocessed memos: ${list}. Review for KB promotion per CLAUDE.md rules, then delete processed memos.`,
    }));
  } else {
    console.log(JSON.stringify({
      systemMessage: `KB promotion reminder: unprocessed memos in .claude/coral/memo/ - ${list}`,
    }));
  }
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
