#!/usr/bin/env node

/**
 * UserPromptSubmit hook — reminds Claude to write memos for non-obvious discoveries.
 * Throttled: once per 30 minutes per session via flag file mtime check.
 * Fail-open: any error exits silently.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const THROTTLE_MIN = 30;
const FLAG_PREFIX = 'memo-reminded-';

try {
  const input = JSON.parse(await readStdin());
  const sessionId = input.session_id;
  if (!sessionId) process.exit(0);

  const projectDir = process.env.CLAUDE_PROJECT_DIR || '.';
  const projectSlug = projectDir.replace(/\//g, '-');
  const flagDir = join(tmpdir(), 'coral', projectSlug);
  const flag = join(flagDir, `${FLAG_PREFIX}${sessionId}`);

  if (existsSync(flag)) {
    const ageMin = (Date.now() - statSync(flag).mtimeMs) / 60_000;
    if (ageMin < THROTTLE_MIN) process.exit(0);
  }

  mkdirSync(flagDir, { recursive: true });
  writeFileSync(flag, '');

  const memoDir = join(coralProjectDir(projectDir), 'memo');
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `Memo reminder: When you discover something non-obvious during this task (painful root cause, unexpected gotcha, clever solution), write immediately to ${memoDir}/<timestamp>-<topic>.md. Keep brief - one paragraph + context.`,
    },
  }));
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
