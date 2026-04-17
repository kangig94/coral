#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exitIfChildProcess, exitIfWrongFlavor, readStdin, resolveProjectSource, coralProjectDir, resolveKbRoot } from './lib/hook-utils.mjs';
import { activeBridgeCommand } from './lib/plugin-paths.mjs';

function stripSessionIdOnly(text) {
  return text.replace(/<!-- SESSION_ID_ONLY:BEGIN -->[\s\S]*?<!-- SESSION_ID_ONLY:END -->\n?/g, '');
}

function stripOwnerOnly(text) {
  return text.replace(/<!-- OWNER_ONLY:BEGIN -->[\s\S]*?<!-- OWNER_ONLY:END -->\n?/g, '');
}

exitIfChildProcess();
exitIfWrongFlavor();

try {
  await readStdin();
  const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || '';
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  const cliPath = activeBridgeCommand(PLUGIN_ROOT);

  if (!PLUGIN_ROOT || !existsSync(PLUGIN_ROOT)) process.exit(0);

  const injectText = readFileSync(join(PLUGIN_ROOT, 'INJECT.md'), 'utf-8');
  const substituted = stripOwnerOnly(stripSessionIdOnly(injectText))
    .replaceAll('{{CORAL_CLI}}', cliPath)
    .replaceAll('{{CORAL_KB}}', resolveKbRoot())
    .replaceAll('{{SESSION_ID}}', '')
    .replaceAll('{{CORAL_PROJECTS}}', projectDir ? coralProjectDir(projectDir) : '{{CORAL_PROJECTS}}')
    .replaceAll('{{PROJECT_SOURCE}}', projectDir ? resolveProjectSource(projectDir) : '{{PROJECT_SOURCE}}');

  console.log(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: substituted },
  }));
} catch {
  process.exit(0);
}
