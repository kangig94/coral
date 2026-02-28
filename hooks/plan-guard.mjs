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
        'Re-read skills/plan/SKILL.md to recover your role and protocol. You MUST follow the Planning_Protocol exactly.',
        'Re-read your plan file in .claude/coral/plans/ to recover your progress.',
        'Determine your position: which step (1-5)? If in step 4, which phase (1=Codex, 2=Claude) and round? Check the last "Round N Summary" heading in the plan file.',
        'Resume from that exact position. Do NOT start over or repeat completed rounds.',
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
