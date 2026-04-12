#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { exitIfChildProcess, exitIfWrongFlavor, readStdin, resolveProjectSource, coralProjectDir, resolveKbRoot, isOwnerId } from './lib/hook-utils.mjs';
exitIfChildProcess();
exitIfWrongFlavor();

function stripSessionIdOnly(text) {
  return text.replace(/<!-- SESSION_ID_ONLY:BEGIN -->[\s\S]*?<!-- SESSION_ID_ONLY:END -->\n?/g, '');
}

try {
  const input = JSON.parse(await readStdin());
  const sessionId = input.session_id;
  const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || '';
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  const cliPath = `node "${join(PLUGIN_ROOT, 'bridge', 'coral-cli.cjs')}"`;


  if (!PLUGIN_ROOT || !existsSync(PLUGIN_ROOT)) process.exit(0);

  const gitRoot = projectDir ? findGitRoot(projectDir) : undefined;
  ensureCliPermission();
  if (projectDir && process.env.CORAL_AUTO_SYMLINK === '1') {
    ensureCoralSymlink(projectDir, gitRoot);
  }

  const ownerSessionId = isOwnerId(sessionId) ? sessionId : undefined;
  const injectText = readFileSync(join(PLUGIN_ROOT, 'INJECT.md'), 'utf-8');
  const substituted = injectText
    .replaceAll('{{CORAL_KB}}', resolveKbRoot())
    .replaceAll('{{CORAL_CLI}}', cliPath)
    .replaceAll('{{SESSION_ID}}', ownerSessionId || '')
    .replaceAll('{{CORAL_PROJECTS}}', projectDir ? coralProjectDir(projectDir) : '{{CORAL_PROJECTS}}')
    .replaceAll('{{PROJECT_SOURCE}}', projectDir ? resolveProjectSource(projectDir) : '{{PROJECT_SOURCE}}');
  const injectContent = ownerSessionId ? substituted : stripSessionIdOnly(substituted);
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

function findGitRoot(cwd) {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return undefined;
  }
}

function addGitignoreEntry(projectDir, entry, gitRoot) {
  try {
    const baseDir = gitRoot ?? projectDir;
    const fullEntry = gitRoot && gitRoot !== projectDir
      ? join(relative(gitRoot, projectDir), entry)
      : entry;
    const gitignore = join(baseDir, '.gitignore');
    const content = existsSync(gitignore) ? readFileSync(gitignore, 'utf-8') : '';
    if (!content.split('\n').includes(fullEntry)) {
      writeFileSync(gitignore, content + (content.endsWith('\n') || !content ? '' : '\n') + fullEntry + '\n');
    }
  } catch {
    // fail-open
  }
}

function ensureCoralSymlink(projectDir, gitRoot) {
  const link = join(projectDir, '.claude', 'coral');
  const target = coralProjectDir(projectDir);
  try {
    if (existsSync(link)) return;
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link);
  } catch {
    return; // lost race or fs error — skip gitignore
  }
  addGitignoreEntry(projectDir, '.claude/coral', gitRoot);
}

function ensureCliPermission() {
  const rule = 'Bash(node *coral-cli*)';
  const dir = join(homedir(), '.claude');
  const file = join(dir, 'settings.json');
  try {
    const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : {};
    const allow = settings.permissions?.allow ?? [];
    if (allow.includes(rule)) return;
    if (!settings.permissions) settings.permissions = {};
    if (!settings.permissions.allow) settings.permissions.allow = [];
    settings.permissions.allow.push(rule);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  } catch {
    // fail-open
  }
}
