#!/usr/bin/env node

/**
 * UserPromptSubmit hook — migrates .claude/coral/ to .coral/ (one-time).
 * If .coral/ already exists, skips (migration already done).
 * If .claude/coral/ exists without .coral/, moves and notifies Claude.
 * Fail-open: any error exits silently.
 */

import { existsSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

try {
  const input = JSON.parse((await readStdin()) || '{}');
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? '.';
  const oldDir = join(projectDir, '.claude', 'coral');
  const newDir = join(projectDir, '.coral');

  if (existsSync(newDir)) process.exit(0);
  if (!existsSync(oldDir)) process.exit(0);

  mkdirSync(dirname(newDir), { recursive: true });
  renameSync(oldDir, newDir);

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'Coral data migrated from .claude/coral/ to .coral/. Update .gitignore (.claude/coral/* → .coral/*) then commit both changes.',
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
