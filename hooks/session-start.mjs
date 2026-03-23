#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

try {
  const input = JSON.parse(await readStdin());
  const sessionId = input.session_id;
  const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || '';
  const projectDir = process.env.CLAUDE_PROJECT_DIR;
  const cliPath = `node "${PLUGIN_ROOT}/bridge/coral-cli.cjs"`;

  if (!PLUGIN_ROOT || !existsSync(PLUGIN_ROOT)) process.exit(0);

  if (projectDir) ensureCliPermission(projectDir);

  const injectText = readFileSync(`${PLUGIN_ROOT}/INJECT.md`, 'utf-8');
  const injectContent = injectText
    .replaceAll('{{CORAL_KB}}', resolveKbRoot())
    .replaceAll('{{CORAL_CLI}}', cliPath)
    .replaceAll('{{CORAL_PROJECTS}}', projectDir ? coralProjectDir(projectDir) : '{{CORAL_PROJECTS}}')
    .replaceAll('{{PROJECT_SOURCE}}', projectDir ? resolveProjectSource(projectDir) : '{{PROJECT_SOURCE}}');
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

function resolveKbRoot() {
  const custom = process.env.CORAL_KB_PATH;
  if (custom) return custom.startsWith('~') ? join(homedir(), custom.slice(1)) : custom;
  return join(homedir(), '.coral', 'kb');
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

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve('{}'));
  });
}
