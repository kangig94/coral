#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exitIfChildProcess, readStdin, resolveProjectSource, coralProjectDir, resolveKbRoot, isOwnerId } from './lib/hook-utils.mjs';
exitIfChildProcess();

function stripOwnerOnlyBlock(text) {
  return text.replace(/<!-- SESSION_ID_ONLY:BEGIN -->[\s\S]*?<!-- SESSION_ID_ONLY:END -->\n?/g, '');
}

try {
  const input = JSON.parse(await readStdin());
  const sessionId = input.session_id;
  const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || '';
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  const cliPath = `node "${join(PLUGIN_ROOT, 'bridge', 'coral-cli.cjs')}"`;


  if (!PLUGIN_ROOT || !existsSync(PLUGIN_ROOT)) process.exit(0);

  if (projectDir) ensureCliPermission(projectDir);

  const ownerSessionId = isOwnerId(sessionId) ? sessionId : undefined;
  const injectText = readFileSync(join(PLUGIN_ROOT, 'INJECT.md'), 'utf-8');
  const substituted = injectText
    .replaceAll('{{CORAL_KB}}', resolveKbRoot())
    .replaceAll('{{CORAL_CLI}}', cliPath)
    .replaceAll('{{SESSION_ID}}', ownerSessionId || '')
    .replaceAll('{{CORAL_PROJECTS}}', projectDir ? coralProjectDir(projectDir) : '{{CORAL_PROJECTS}}')
    .replaceAll('{{PROJECT_SOURCE}}', projectDir ? resolveProjectSource(projectDir) : '{{PROJECT_SOURCE}}');
  const injectContent = ownerSessionId ? substituted : stripOwnerOnlyBlock(substituted);
  const additionalContext = sessionId
    ? `SessionStart:session_id=${sessionId}\n\n${injectContent}`
    : injectContent;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }));
} catch {
  process.exit(0);
}

function ensureCliPermission(projectDir) {
  const rule = 'Bash(node *coral-cli*)';
  const dir = join(projectDir, '.claude');
  const path = join(dir, 'settings.local.json');
  try {
    const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : {};
    const allow = settings.permissions?.allow ?? [];
    if (allow.includes(rule)) return;
    if (!settings.permissions) settings.permissions = {};
    if (!settings.permissions.allow) settings.permissions.allow = [];
    settings.permissions.allow.push(rule);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
  } catch {
    // fail-open
  }
}
