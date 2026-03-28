#!/usr/bin/env node

/**
 * UserPromptSubmit hook — reminds Claude to write memos for non-obvious discoveries.
 * Throttled: once per 30 minutes per session via flag file mtime check.
 * Fail-open: any error exits silently.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exitIfChildProcess, readStdin, coralProjectDir, sweepStale, isOwnerId } from './lib/hook-utils.mjs';
exitIfChildProcess();

const THROTTLE_MIN = 30;
const FLAG_PREFIX = 'memo-reminded-';

try {
  const input = JSON.parse(await readStdin());
  const sessionId = input.session_id;
  if (!sessionId) process.exit(0);
  if (!isOwnerId(sessionId)) process.exit(0);

  const projectDir = process.env.CLAUDE_PROJECT_DIR || '.';
  const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || '';
  const cliPath = `node "${join(PLUGIN_ROOT, 'bridge', 'coral-cli.cjs')}"`;
  const projectSlug = projectDir.replace(/\//g, '-');
  const flagDir = join(tmpdir(), 'coral', projectSlug);
  const flag = join(flagDir, `${FLAG_PREFIX}${sessionId}`);

  if (existsSync(flag)) {
    const ageMin = (Date.now() - statSync(flag).mtimeMs) / 60_000;
    if (ageMin < THROTTLE_MIN) process.exit(0);
  }

  mkdirSync(flagDir, { recursive: true });
  sweepStale(flagDir, FLAG_PREFIX, 2 * 60 * 60_000);
  writeFileSync(flag, '');

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `Memo reminder: When you discover something non-obvious during this task (painful root cause, unexpected gotcha, clever solution), write immediately with ${cliPath} kb memo write --owner "${sessionId}" --topic "<kebab-case-topic>" --content "one paragraph + context".`,
    },
  }));
} catch {
  process.exit(0);
}
