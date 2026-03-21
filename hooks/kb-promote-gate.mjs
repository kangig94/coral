#!/usr/bin/env node

/**
 * Multi-event hook for KB promotion workflow:
 * - UserPromptSubmit: create session-scoped kb-active flag for user-typed /coral:ralph|bugfix
 * - PreToolUse(Skill): create session-scoped kb-active flag for Claude-initiated Skill() calls
 * - Stop: remind to promote memos if this session's flag exists
 * - SessionStart(compact): always check for unprocessed memos after compaction
 * Fail-open: any error exits silently.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

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
  }

  // Check for unprocessed memos (Stop + SessionStart compact)
  const memoDir = join(coralProjectDir(projectDir), 'memo');
  if (!existsSync(memoDir)) process.exit(0);

  const memos = readdirSync(memoDir).filter(f => !f.startsWith('.'));
  const list = memos.join(', ');
  const sessionKb = 'If you learned anything during this session that would be useful in future sessions, preserve the memo -> review -> promotion workflow and promote only durable knowledge to ~/.coral/kb/ after reviewing memos. Do not bypass memo review.';

  if (event === 'Stop') {
    console.log(JSON.stringify({
      decision: 'block',
      reason: memos.length > 0
        ? `Review each memo, then promote only durable knowledge to ~/.coral/kb/ if it is useful across sessions. Delete all processed memos regardless of promotion. Preserve the memo -> review -> promotion workflow; do not bypass memo review. Memos: ${list}`
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
          : sessionKb,
      },
    }));
  }
} catch {
  process.exit(0);
}

function resolveProjectSource(projectDir) {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd: projectDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().replace(/\.git$/, '');
    const sshPath = remote.match(/^[^@]+@[^:]+:(.+)$/)?.[1];
    const rawPath = sshPath ?? remote.replace(/^[^:]+:\/\//, '').replace(/^[^@/]+@/, '').replace(/^[^/]+\/+/, '');
    const segments = rawPath.split('/').filter(Boolean);
    if (segments.length >= 2) return `${segments.at(-2)}/${segments.at(-1)}`;
  } catch {
    // fall through
  }
  return `local/${basename(projectDir)}`;
}

function coralProjectDir(projectDir) {
  return join(homedir(), '.coral', 'projects', resolveProjectSource(projectDir).replace(/\//g, '-'));
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve('{}'));
  });
}
