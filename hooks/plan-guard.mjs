#!/usr/bin/env node

/**
 * SessionStart(compact) hook — prevents premature implementation after compaction.
 * When plan mode was active during compaction, injects context forcing Claude
 * to continue planning instead of starting implementation.
 * Fail-open: any error exits silently.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

try {
  const input = JSON.parse(await readStdin());
  const sessionId = input.session_id;
  if (!sessionId) process.exit(0);

  const flagDir = join(process.env.CLAUDE_PROJECT_DIR || '.', '.claude', 'coral', 'tmp');
  const flag = join(flagDir, `plan-active-${sessionId}`);

  if (!existsSync(flag)) process.exit(0);

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: [
        'PLAN MODE ACTIVE — DO NOT IMPLEMENT.',
        'Context compaction just occurred while you were executing the /coral:plan skill.',
        'Re-read skills/plan/SKILL.md and skills/plan/PROTOCOL.md to recover your role and protocol.',
        'Re-read your plan file in .claude/coral/plans/ to recover your progress.',
        'Resume from where you left off. Do NOT start over.',
      ].join('\n'),
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
