#!/usr/bin/env node

/**
 * Multi-event hook for KB promotion workflow:
 * - UserPromptSubmit: create session-scoped kb-active flag for user-typed /coral:ralph|bugfix
 * - PreToolUse(Skill): create session-scoped kb-active flag for Claude-initiated Skill() calls
 * - Stop: remind to promote memos if this session's flag exists
 * - SessionStart(compact): always check for unprocessed memos after compaction
 * Fail-open: any error exits silently.
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FLAG_PREFIX = 'kb-active-';
const KB_SKILL_RE = /\/(?:coral:)?ralph|\/(?:coral:)?bugfix/;

try {
  const input = JSON.parse(await readStdin());
  const event = input.hook_event_name;
  const sessionId = input.session_id;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || '.';
  const flagDir = join(projectDir, '.claude', 'coral', 'tmp');

  // UserPromptSubmit: user typed /coral:ralph or /coral:bugfix directly
  if (event === 'UserPromptSubmit') {
    if (!sessionId) process.exit(0);
    const msg = input.user_message || input.message || input.prompt || '';
    if (!KB_SKILL_RE.test(msg)) process.exit(0);
    mkdirSync(flagDir, { recursive: true });
    writeFileSync(join(flagDir, `${FLAG_PREFIX}${sessionId}`), '');
    process.exit(0);
  }

  // PreToolUse(Skill): Claude-initiated Skill("coral:ralph"|"coral:bugfix") calls
  if (event === 'PreToolUse') {
    if (!sessionId) process.exit(0);
    const skill = input.tool_input?.skill || '';
    if (!/coral:ralph|coral:bugfix/.test(skill)) process.exit(0);
    mkdirSync(flagDir, { recursive: true });
    writeFileSync(join(flagDir, `${FLAG_PREFIX}${sessionId}`), '');
    process.exit(0);
  }

  // Stop: check session-scoped flag
  if (event === 'Stop') {
    const flag = sessionId && join(flagDir, `${FLAG_PREFIX}${sessionId}`);
    if (!flag || !existsSync(flag)) process.exit(0);
    try { unlinkSync(flag); } catch { /* ignore */ }
  }

  // Check for unprocessed memos (Stop + SessionStart compact)
  const memoDir = join(projectDir, '.claude', 'coral', 'memo');
  if (!existsSync(memoDir)) process.exit(0);

  const memos = readdirSync(memoDir).filter(f => !f.startsWith('.'));
  const list = memos.join(', ');
  const sessionKb = 'If you learned anything during this session that would be useful in future sessions, write it directly to .claude/coral/kb/.';

  if (event === 'Stop') {
    console.log(JSON.stringify({
      decision: 'block',
      reason: memos.length > 0
        ? `Review each memo — promote to .claude/coral/kb/ only if useful across sessions. Delete all processed memos regardless of promotion. Also, ${sessionKb} Memos: ${list}`
        : `No memos to process, but ${sessionKb}`,
      systemMessage: memos.length > 0
        ? `📋 KB: promoting ${memos.length} memo(s)`
        : '📋 KB: checking session knowledge',
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
