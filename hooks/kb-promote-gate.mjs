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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStdin, coralProjectDir, sweepStale } from './lib/hook-utils.mjs';

const FLAG_PREFIX = 'kb-active-';
const KB_SKILL_RE = /\/(?:coral:)?ralph|\/(?:coral:)?bugfix/;

try {
  const input = JSON.parse(await readStdin());
  const event = input.hook_event_name;
  const sessionId = input.session_id;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || '.';
  const projectSlug = projectDir.replace(/\//g, '-');
  const flagDir = join(tmpdir(), 'coral', projectSlug);

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
    sweepStale(flagDir, FLAG_PREFIX, 24 * 60 * 60_000);
  }

  // Check for unprocessed memos (Stop + SessionStart compact)
  const memoDir = join(coralProjectDir(projectDir), 'memo');
  if (!existsSync(memoDir)) process.exit(0);

  const memos = readdirSync(memoDir).filter(f => !f.startsWith('.'));
  const list = memos.join(', ');
  const sessionKb = 'If you learned anything during this session that would be useful in future sessions, preserve the memo -> review -> promotion workflow and promote only durable knowledge via CLI kb promote after reviewing memos. Use CLI kb search to check for duplicates first. Do not bypass memo review.';

  if (event === 'Stop') {
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: memos.length > 0
        ? `Review each memo, use CLI kb search to check for duplicates, then promote only durable knowledge via CLI kb promote if it is useful across sessions. Delete all processed memos regardless of promotion. Preserve the memo -> review -> promotion workflow; do not bypass memo review. Memos: ${list}`
        : `No memos to process, but ${sessionKb}`,
      systemMessage: memos.length > 0
        ? `📋 KB: promoting ${memos.length} memo(s)`
        : '📋 KB: checking session knowledge',
    }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: memos.length > 0
          ? `KB promotion reminder: promote only if useful across sessions. Also, ${sessionKb} Memos: ${list}`
          : sessionKb,
      },
    }) + '\n');
  }
} catch {
  process.exit(0);
}
