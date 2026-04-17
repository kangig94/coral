#!/usr/bin/env node

/**
 * UserPromptSubmit hook — reminds Claude to write memos for non-obvious discoveries.
 * Throttled: once per 30 minutes per session via flag file mtime check.
 * Fail-open: any error exits silently.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exitIfChildProcess, exitIfWrongFlavor, readStdin, coralProjectDir, sweepStale, isValidSessionId } from './lib/hook-utils.mjs';
import { activeBridgeCommand, projectDirFromInput, projectTmpDir } from './lib/plugin-paths.mjs';
exitIfChildProcess();
exitIfWrongFlavor();

const THROTTLE_MIN = 60;
const FLAG_PREFIX = 'memo-reminded-';

try {
  const input = JSON.parse(await readStdin());
  const sessionId = input.session_id;
  if (!sessionId) process.exit(0);
  if (!isValidSessionId(sessionId)) process.exit(0);

  const projectDir = projectDirFromInput(input);
  const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || '';
  const cliPath = activeBridgeCommand(PLUGIN_ROOT);
  const flagDir = projectTmpDir(projectDir);
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
      additionalContext: `Memo reminder: When you discover something that would save someone hours (painful root cause, gotcha contradicting docs), write with ${cliPath} kb memo write --owner "${sessionId}" --topic "<kebab-case-topic>" --content "one paragraph + context". Do not memo routine findings.`,
    },
  }));
} catch {
  process.exit(0);
}
