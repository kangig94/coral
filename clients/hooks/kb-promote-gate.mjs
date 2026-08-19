#!/usr/bin/env node

/**
 * Multi-event hook for KB promotion workflow:
 * - UserPromptSubmit: create session-scoped kb-active flag for user-typed /coral:ralph|bugfix
 * - PreToolUse(Skill): create session-scoped kb-active flag for Claude-initiated Skill() calls
 * - Stop: remind to promote memos if this session's flag exists
 * - SessionStart(compact): always check for unprocessed memos after compaction
 * Fail-open: any error exits silently.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  coralProjectDir,
  exitIfChildProcess,
  exitIfWrongFlavor,
  isValidSessionId,
  readMemoOwnerFromFrontmatter,
  readStdin,
  readUserMessage,
  sweepStale,
  writeHookOutput,
} from './lib/hook-utils.mjs';
import { projectDirFromInput, projectTmpDir } from './lib/plugin-paths.mjs';
import { isKbSkillField, KB_SKILL_MESSAGE_RE } from './lib/coral-skills.mjs';
import { hasLiveWork } from './lib/live-work-registry.mjs';
import { isKbEnabled } from './lib/kb-toggle.mjs';
exitIfChildProcess();
exitIfWrongFlavor();
if (!isKbEnabled()) process.exit(0);

const FLAG_PREFIX = 'kb-active-';
const FLAG_SWEEP_TTL_MS = 24 * 60 * 60_000;
const SESSION_KB_REMINDER = 'If you learned anything during this session that would be useful in future sessions, preserve the memo -> review -> promotion workflow and promote only durable knowledge via CLI kb promote after reviewing memos. Use CLI kb search to check for duplicates first. Do not bypass memo review.';

try {
  const input = JSON.parse(await readStdin());
  const event = input.hook_event_name;
  const sessionId = input.session_id;
  const projectDir = projectDirFromInput(input);
  const flagDir = projectTmpDir(projectDir);

  // UserPromptSubmit: user typed /coral:ralph or /coral:bugfix directly
  if (event === 'UserPromptSubmit') {
    if (!sessionId) process.exit(0);
    if (!KB_SKILL_MESSAGE_RE.test(readUserMessage(input))) process.exit(0);
    mkdirSync(flagDir, { recursive: true });
    writeFileSync(join(flagDir, `${FLAG_PREFIX}${sessionId}`), '');
    process.exit(0);
  }

  // PreToolUse(Skill): Claude-initiated Skill("coral:ralph"|"coral:bugfix") calls
  if (event === 'PreToolUse') {
    if (!sessionId) process.exit(0);
    const skill = input.tool_input?.skill || '';
    if (!isKbSkillField(skill)) process.exit(0);
    mkdirSync(flagDir, { recursive: true });
    writeFileSync(join(flagDir, `${FLAG_PREFIX}${sessionId}`), '');
    process.exit(0);
  }

  // Check for unprocessed memos (Stop + SessionStart compact)
  const memoDir = join(coralProjectDir(projectDir), 'memo');
  if (!existsSync(memoDir)) process.exit(0);

  const memoFiles = readdirSync(memoDir)
    .filter(name => name.endsWith('.md'))
    .filter(name => { try { return statSync(join(memoDir, name)).isFile(); } catch { return false; } });

  // Derive session-visible memos: owner matches session or no owner is recorded.
  const validSession = isValidSessionId(sessionId);
  const visibleMemos = validSession ? memoFiles.filter(name => {
    try {
      const content = readFileSync(join(memoDir, name), 'utf-8');
      const memoOwner = readMemoOwnerFromFrontmatter(content);
      return memoOwner === undefined || memoOwner === sessionId;
    } catch {
      return false; // per-file isolation — do not disable the whole gate
    }
  }) : [];

  // Stop: check session-scoped flag; use visibleMemos for blocking
  if (event === 'Stop') {
    // Defer while any background work (subagent or backgrounded Bash/Monitor) is
    // still running — keep the flag and memos intact so the reminder fires once
    // the session truly winds down.
    const liveWork = hasLiveWork(projectDir, sessionId, input.transcript_path);
    if (liveWork.live) {
      if (liveWork.notice) writeHookOutput({ systemMessage: `KB memo review is deferring: ${liveWork.notice}` });
      process.exit(0);
    }
    const flag = sessionId && join(flagDir, `${FLAG_PREFIX}${sessionId}`);
    const hasFlag = flag && existsSync(flag);
    if (hasFlag) {
      try { unlinkSync(flag); } catch { /* ignore */ }
    }
    sweepStale(flagDir, FLAG_PREFIX, FLAG_SWEEP_TTL_MS);
    if (visibleMemos.length >= 10) {
      const list = visibleMemos.join(', ');
      writeHookOutput({
        decision: 'block',
        reason: `Review each memo, use CLI kb search to check for duplicates, then promote only durable knowledge via CLI kb promote if it is useful across sessions. Delete all processed memos regardless of promotion. Preserve the memo -> review -> promotion workflow; do not bypass memo review. Memos: ${list}`,
        systemMessage: `📋 KB: promoting ${visibleMemos.length} memo(s)`,
      });
    } else if (hasFlag) {
      writeHookOutput({
        decision: 'block',
        reason: `No memos to process, but ${SESSION_KB_REMINDER}`,
        systemMessage: '📋 KB: checking session knowledge',
      });
    } else {
      process.exit(0);
    }
  } else {
    // SessionStart (compact)
    if (!validSession) {
      // Degraded path: no valid session_id — emit generic reminder without listing memo names
      writeHookOutput({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: memoFiles.length > 0
            ? `KB promotion reminder: unprocessed memos exist. Promote only if useful across sessions. Also, ${SESSION_KB_REMINDER}`
            : SESSION_KB_REMINDER,
        },
      });
    } else if (visibleMemos.length > 0) {
      const list = visibleMemos.join(', ');
      writeHookOutput({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `KB promotion reminder: promote only if useful across sessions. Also, ${SESSION_KB_REMINDER} Memos: ${list}`,
        },
      });
    } else {
      writeHookOutput({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: SESSION_KB_REMINDER,
        },
      });
    }
  }
} catch {
  process.exit(0);
}
