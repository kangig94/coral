#!/usr/bin/env node

/**
 * Stop/SessionStart(compact) hook — enforces KB promotion for unprocessed memos.
 * Stop: skill-scoped via .claude/coral/tmp/kb-active state file.
 * SessionStart(compact): always checks for unprocessed memos after compaction.
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
  const list = memos.join(', ');
  const sessionKb = 'If you learned anything during this session that would be useful in future sessions, write it directly to .claude/coral/kb/.';

  if (event === 'Stop') {
    console.log(JSON.stringify({
      decision: 'block',
      reason: memos.length > 0
        ? `Not an error. Review each memo — promote to .claude/coral/kb/ only if useful across sessions. Delete all processed memos regardless of promotion. Also, ${sessionKb} Memos: ${list}`
        : `Not an error. No memos to process, but ${sessionKb}`,
    }));
  } else {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: memos.length > 0
          ? `KB promotion reminder: promote only if useful across sessions. Also, ${sessionKb} Memos: ${list}`
          : `KB reminder: ${sessionKb}`,
      },
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
