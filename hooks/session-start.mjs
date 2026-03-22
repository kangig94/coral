#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

try {
  const input = JSON.parse(await readStdin());
  const sessionId = input.session_id;
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const projectDir = process.env.CLAUDE_PROJECT_DIR;

  if (!pluginRoot || !existsSync(pluginRoot)) process.exit(0);

  const injectText = readFileSync(`${pluginRoot}/INJECT.md`, 'utf-8');
  const injectContent = injectText
    .replaceAll('{{CORAL_KB}}', resolveKbRoot())
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

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve('{}'));
  });
}
